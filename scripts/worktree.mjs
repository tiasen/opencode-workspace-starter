#!/usr/bin/env node
/**
 * worktree.mjs — 并行检出（worktree）管理
 *
 * 概念：一个 worktree = 一整套检出（workspace-root + .code-workspace 里的全部
 * 子应用），全部落在同一条分支上，不可分割。并行的单位是整套检出，不是单个仓。
 *
 * 目录布局（镜像主树，保证已提交的 .code-workspace 无需修改即可解析）：
 *
 *   P/                                  ← 主树父目录
 *   ├── my-project/                     workspace-root 主检出 (main)
 *   ├── frontend/                       (main)
 *   ├── backend/                        (main)
 *   └── worktrees/
 *       └── feat-a/                     ← 检出根目录 I
 *           ├── .worktree.jsonc         ← 清单（本地状态，不在任何 git 仓内）
 *           ├── my-project/             @ feat-a
 *           ├── frontend/               @ feat-a
 *           └── backend/                @ feat-a
 *
 * 用法:
 *   node scripts/worktree.mjs new <id> [--base <ref>] [--fetch] [--no-install] [--json]
 *   node scripts/worktree.mjs open <id> [--exec]
 *   node scripts/worktree.mjs install <id>
 *   node scripts/worktree.mjs list [--json]
 *   node scripts/worktree.mjs which
 *   node scripts/worktree.mjs doctor [<id>]
 *   node scripts/worktree.mjs remove <id> [--force]
 *   node scripts/worktree.mjs prune
 *
 * 全局选项: --workspace <file>  --root <dir>  --worktrees-dir <dir>
 *
 * 零依赖：仅使用 Node 内置模块。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findWorkspaceFile,
  loadWorkspace,
  buildFolderModels,
  resolveMemberPath,
  worktreeWorkspaceDir,
  findEnclosingWorktree,
} from "./workspace-lib.mjs";

const STARTER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_NAME = ".worktree.jsonc";
const WORKTREES_DIR_NAME = "worktrees";

/** 种入实时定义时排除的路径前缀：openspec/changes 是"当次变更的工作区"，必须隔离。 */
const SEED_EXCLUDE_PREFIXES = ["openspec/changes/"];

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const log = (m) => process.stdout.write(`${m}\n`);
const warn = (m) => process.stderr.write(`[warn] ${m}\n`);
function fail(msg, code = 1) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// git 小工具
// ---------------------------------------------------------------------------

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 返回仓库顶层目录；不在任何 git 仓内返回 null。 */
function gitTopLevel(cwd) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

function hasCommits(cwd) {
  return gitOk(cwd, ["rev-parse", "--verify", "HEAD"]);
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    _: [],
    workspace: null,
    root: null,
    worktreesDir: null,
    base: null,
    fetch: false,
    install: true,
    json: false,
    exec: false,
    force: false,
  };
  const bools = new Set(["fetch", "json", "exec", "force"]);
  const valued = new Set(["workspace", "root", "worktreesDir", "base"]);
  // argv[2] 是子命令，从 3 开始解析，否则子命令会被当成第一个位置参数（id）。
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-install") {
      out.install = false;
      continue;
    }
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (bools.has(key)) {
        out[key] = true;
        continue;
      }
      if (valued.has(key)) {
        out[key] = eq === -1 ? argv[++i] : a.slice(eq + 1);
        continue;
      }
      warn(`未知参数已忽略: ${a}`);
      continue;
    }
    out._.push(a);
  }
  return out;
}

function printHelp() {
  log(`用法: node scripts/worktree.mjs <command> [args] [options]`);
  log(`命令:`);
  log(`  new <id>        创建一整套并行检出（workspace-root + 全部子应用）`);
  log(`  open <id>       输出（或 --exec 直接启动）该检出的 opencode 启动命令`);
  log(`  install <id>    为检出的各成员安装依赖`);
  log(`  list            列出所有检出`);
  log(`  which           显示当前所在的是 worktree 还是主树`);
  log(`  doctor [<id>]   校验检出的完整性（成员齐备 / 分支一致 / 依赖就绪）`);
  log(`  remove <id>     删除检出（默认拒绝有未提交或未合并的改动，--force 强制）`);
  log(`  prune           清理各仓中失效的 worktree 元数据`);
  log(`选项:`);
  log(`  --base <ref>          新分支的起点（默认：本地 main → master → origin/HEAD → 当前分支）`);
  log(`  --fetch               创建前先 git fetch --prune`);
  log(`  --no-install          创建后不自动安装依赖`);
  log(`  --json                new / list 输出结构化结果`);
  log(`  --force               remove 时强制删除`);
  log(`  --workspace <file>    指定 .code-workspace`);
  log(`  --root <dir>          workspace-root（默认：starter 根）`);
  log(`  --worktrees-dir <dir> 检出根目录（默认：workspace 文件父目录下的 worktrees/）`);
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

function loadContext(args) {
  // 若当前在某个 worktree 内，基准必须从它的清单反推：
  // 实例里的 .code-workspace 解析出来的是实例成员，不是主树，不能当作主树路径用。
  const enclosing = findEnclosingWorktree(process.cwd());
  let root;
  let wtRoot = null;
  if (enclosing) {
    const m = readManifest(enclosing.root);
    const rootMember = m?.members?.find((x) => x.repo === "workspace-root");
    if (!rootMember) {
      fail(`worktree 清单缺少 workspace-root 成员，无法定位主树: ${manifestPath(enclosing.root)}`);
    }
    root = args.root ? path.resolve(process.cwd(), args.root) : rootMember.main;
    wtRoot = args.worktreesDir
      ? path.resolve(process.cwd(), args.worktreesDir)
      : path.dirname(enclosing.root);
  } else {
    root = args.root ? path.resolve(process.cwd(), args.root) : STARTER_ROOT;
  }

  const wsFile = findWorkspaceFile({ root, explicit: args.workspace });
  if (!wsFile) {
    fail("未找到 .code-workspace 文件。请用 --workspace 指定，或从 template.code-workspace 复制一份。");
  }
  let ws;
  try {
    ws = loadWorkspace(wsFile);
  } catch (err) {
    fail(err.message);
  }
  const folders = buildFolderModels(ws.folders, ws.dir, root, { log, warn });
  if (folders.length === 0) fail("没有可用的 folder 条目。");
  if (!wtRoot) {
    wtRoot = args.worktreesDir
      ? path.resolve(process.cwd(), args.worktreesDir)
      : path.join(path.dirname(root), WORKTREES_DIR_NAME);
  }
  return { root, wsFile, wsDir: ws.dir, folders, wtRoot, enclosing };
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

function manifestPath(root) {
  return path.join(root, MANIFEST_NAME);
}

function readManifest(root) {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeManifest(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function listWorktrees(wtRoot) {
  const out = [];
  if (!fs.existsSync(wtRoot)) return out;
  for (const entry of fs.readdirSync(wtRoot)) {
    const dir = path.join(wtRoot, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const m = readManifest(dir);
    out.push({ root: dir, id: entry, manifest: m, broken: m === null });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function resolveWorktreeOrFail(wtRoot, id) {
  const dir = path.join(wtRoot, id);
  const m = readManifest(dir);
  if (!m) fail(`未找到 worktree: ${id}（${dir}）`);
  return { root: dir, manifest: m };
}

function memberAbs(manifest, root, member) {
  return path.resolve(root, member.path);
}

// ---------------------------------------------------------------------------
// git 前置
// ---------------------------------------------------------------------------

/**
 * 确保 workspace-root 是一个独立的 git 仓库且已有至少一个 commit。
 * worktree 的起点必须是 commit，故 bootstrap 是硬前置；这一步自动完成，用户无需感知。
 */
function ensureRepoAndBaseline(dir) {
  const top = gitTopLevel(dir);
  if (top === null) {
    git(dir, ["init", "-b", "main"]);
    log("  ✓ 已初始化 git 仓库（main）");
  } else if (!samePath(top, dir)) {
    fail(
      `workspace-root 位于另一个 git 仓库内部（${top}），无法作为独立仓库创建 worktree。\n` +
        `       请把 workspace-root 作为独立仓库（或调整 .code-workspace 的位置）。`
    );
  }

  if (!hasCommits(dir)) {
    if (!fs.existsSync(path.join(dir, ".gitignore"))) {
      warn("未找到 .gitignore，基线提交可能包含 node_modules 等产物，建议先补齐。");
    }
    try {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-m", "chore: workspace baseline"]);
    } catch (err) {
      fail(
        `创建基线 commit 失败: ${String(err.message).split("\n")[0]}\n` +
          `       请确认已配置 git user.name / user.email。`
      );
    }
    log("  ✓ 已创建基线 commit（仅本地，未 push）");
  }
}

/**
 * 解析新分支的起点：**主检出当前所在分支**优先（用户期望"从我现在打开的分支分叉"），
 * 退化链：远端默认分支 → 本地 main → master → HEAD。可用 --base 显式覆盖。
 */
function resolveBase(repoDir, explicit) {
  if (explicit) return explicit;
  try {
    const cur = git(repoDir, ["symbolic-ref", "--short", "HEAD"]);
    if (cur) return cur;
  } catch {
    /* detached HEAD */
  }
  try {
    const ref = git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (ref) return ref;
  } catch {
    /* 无远端 HEAD */
  }
  if (gitOk(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/main"])) return "main";
  if (gitOk(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/master"])) return "master";
  return "HEAD";
}

function validateId(id) {
  if (!id) fail("缺少 worktree 名称。用法: node scripts/worktree.mjs new <id>");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    fail(`非法名称 "${id}"：只允许小写字母、数字、点、下划线、连字符，且以字母或数字开头。`);
  }
}

// ---------------------------------------------------------------------------
// 种入实时 workspace 定义
// ---------------------------------------------------------------------------

/**
 * 把主树相对 HEAD 的"实时定义漂移"复制进实例的 workspace 目录。
 * 只搬运 workspace 定义（.code-workspace / opencode.jsonc / .opencode / AGENTS.md 等），
 * 明确排除 openspec/changes（那是当次变更的工作区，必须隔离）。
 * 主树的工作区状态完全不影响创建，用户无需先 commit。
 */
function seedContainer(wsDir, dstW) {
  const paths = new Set();
  try {
    for (const p of git(wsDir, ["diff", "--name-only", "HEAD"]).split("\n")) {
      if (p) paths.add(p);
    }
  } catch {
    /* 无 HEAD 等异常忽略 */
  }
  try {
    for (const p of git(wsDir, ["ls-files", "-o", "--exclude-standard"]).split("\n")) {
      if (p) paths.add(p);
    }
  } catch {
    /* ignore */
  }
  let copied = 0;
  const excluded = [];
  for (const rel of paths) {
    if (SEED_EXCLUDE_PREFIXES.some((pre) => rel.startsWith(pre))) {
      excluded.push(rel);
      continue;
    }
    const s = path.join(wsDir, rel);
    if (!fs.existsSync(s) || fs.statSync(s).isDirectory()) continue;
    const d = path.join(dstW, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    copied += 1;
  }
  return { copied, excluded };
}

/** 在实例的 workspace 目录里重跑 init（幂等；用于让 agents/opencode.jsonc 跟随定义）。 */
function runInit(dstW) {
  if (!fs.existsSync(path.join(dstW, "package.json"))) return { ok: false, skipped: true };
  const r = spawnSync("npm", ["run", "init", "--", "--yes"], {
    cwd: dstW,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function commitIfDirty(dir, message) {
  let dirty;
  try {
    dirty = git(dir, ["status", "--porcelain"]);
  } catch {
    return false;
  }
  if (!dirty) return false;
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return true;
}

// ---------------------------------------------------------------------------
// 依赖安装
// ---------------------------------------------------------------------------

function detectInstall(repoDir) {
  const pkgPath = path.join(repoDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  if (deps.length === 0) return null;
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) return ["pnpm", ["install"]];
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) return ["yarn", ["install"]];
  if (fs.existsSync(path.join(repoDir, "bun.lock")) || fs.existsSync(path.join(repoDir, "bun.lockb"))) {
    return ["bun", ["install"]];
  }
  if (fs.existsSync(path.join(repoDir, "package-lock.json"))) return ["npm", ["ci"]];
  return ["npm", ["install"]];
}

/** 各成员并行安装依赖；依赖失败为非致命（结构已经建好，可重试）。 */
function installMembers(members) {
  return members.map((m) => {
    const cmd = detectInstall(m.dir);
    if (!cmd) return { repo: m.repo, status: "skipped" };
    const r = spawnSync(cmd[0], cmd[1], { cwd: m.dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return {
      repo: m.repo,
      status: r.status === 0 ? "ok" : "failed",
      command: `${cmd[0]} ${cmd[1].join(" ")}`,
      error: r.status === 0 ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n"),
    };
  });
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

function cmdNew(args) {
  const id = args._[0];
  validateId(id);

  const ctx = loadContext(args);

  const enclosing = findEnclosingWorktree(process.cwd());
  if (enclosing) {
    fail(`当前目录位于 worktree 内（${enclosing.root}）。请在主树（workspace-root）中运行 new。`);
  }

  // ---- 成员清单：完整性由框架保证，不外包给 .code-workspace ----
  //
  // workspace-root 是框架自身所在目录（含 scripts/），**永远**作为成员创建：
  // .code-workspace 只决定"额外还有哪些成员"，不决定 workspace-root 是否存在。
  const rootDir = ctx.root;
  if (path.resolve(ctx.wsDir) !== path.resolve(rootDir)) {
    fail(
      `.code-workspace 必须位于 workspace-root 内（当前 ${ctx.wsDir}，workspace-root 是 ${rootDir}）。\n` +
        `       放在上级会导致它不被提交，实例里没有 workspace 定义，实例必然不可用。`
    );
  }
  const rootDeclared = ctx.folders.some((f) => path.resolve(f.absPath) === path.resolve(rootDir));
  if (!rootDeclared) {
    warn(
      `.code-workspace 未声明 workspace-root，已按框架自身目录隐式纳入；` +
        `建议补一条 { "name": "workspace-root", "path": "." }（否则 VS Code 侧看不到它）。`
    );
  }

  const plan = [
    { repo: "workspace-root", main: rootDir, rawPath: "." },
    ...ctx.folders
      .filter((f) => path.resolve(f.absPath) !== path.resolve(rootDir))
      .map((f) => ({ repo: f.originalName, main: f.absPath, rawPath: f.rawPath })),
  ];

  const missing = plan.filter((m) => !fs.existsSync(m.main));
  if (missing.length > 0) {
    fail(
      `以下成员路径不存在，请先 clone 后再创建：\n` +
        missing.map((m) => `  - ${m.repo}: ${m.main}`).join("\n")
    );
  }
  const absolute = ctx.folders.filter((f) => f.isAbsolute);
  if (absolute.length > 0) {
    fail(
      `.code-workspace 中存在绝对路径，worktree 的镜像布局要求相对路径：\n` +
        absolute.map((f) => `  - ${f.originalName}: ${f.rawPath}`).join("\n")
    );
  }

  const instRoot = path.join(ctx.wtRoot, id);
  if (fs.existsSync(instRoot)) fail(`worktree 已存在: ${instRoot}`);

  log(`==> 创建 worktree "${id}"`);
  log(`  主树 workspace: ${ctx.wsFile}`);
  log(`  检出根目录: ${instRoot}`);

  ensureRepoAndBaseline(rootDir);

  const instWsDir = worktreeWorkspaceDir(instRoot, rootDir);
  log(`  将创建 ${plan.length} 个成员（base 默认取各主检出当前分支，可用 --base 覆盖）：`);
  for (const m of plan) {
    log(`    ${m.repo.padEnd(16)} ${m.main}`);
  }

  const created = [];

  try {
    for (const m of plan) {
      const mainAbs = m.main;
      const memberDir = resolveMemberPath(instWsDir, m.rawPath);

      if (args.fetch) {
        try {
          git(mainAbs, ["fetch", "--prune"]);
        } catch {
          warn(`${m.repo}: fetch 失败，使用本地 ref。`);
        }
      }
      const base = resolveBase(mainAbs, args.base);

      if (gitOk(mainAbs, ["show-ref", "--verify", "--quiet", `refs/heads/${id}`])) {
        throw new Error(`${m.repo}: 分支 "${id}" 已存在，请先删除或换名`);
      }
      if (fs.existsSync(memberDir)) {
        throw new Error(`${m.repo}: 目标目录已存在 ${memberDir}`);
      }

      git(mainAbs, ["worktree", "add", "-b", id, memberDir, base]);
      created.push({ repo: m.repo, mainAbs, memberDir, base, rawPath: m.rawPath });
      log(`  ✓ ${m.repo} → ${path.relative(process.cwd(), memberDir) || memberDir} (base ${base})`);
    }
  } catch (err) {
    rollback(created, id, instRoot);
    fail(`创建失败，已回滚全部成员：${err.message}`);
  }

  // 种入实时定义 + 重跑 init（幂等）
  const seeded = seedContainer(rootDir, instWsDir);
  const init = runInit(instWsDir);
  let seededCommit = false;
  try {
    seededCommit = commitIfDirty(instWsDir, "chore: seed workspace definition");
  } catch (err) {
    warn(`种子 commit 失败（不影响使用）: ${err.message}`);
  }
  log(`  ✓ 已种入实时 workspace 定义（复制 ${seeded.copied} 个文件${seeded.excluded.length ? `，隔离 ${seeded.excluded.length} 个 openspec/changes 文件` : ""}）`);
  if (!init.ok && !init.skipped) warn(`实例内 npm run init 未成功，可手动运行：cd ${instWsDir} && npm run init -- --yes`);

  // 依赖安装（非致命）
  const members = created.map((c) => ({ repo: c.repo, dir: c.memberDir }));
  let installResults = [];
  if (args.install) {
    log("  ... 安装各成员依赖");
    installResults = installMembers(members);
    for (const r of installResults) {
      if (r.status === "ok") log(`  ✓ ${r.repo}: ${r.command}`);
      else if (r.status === "failed") warn(`${r.repo}: 依赖安装失败（${r.command}），可重试 node scripts/worktree.mjs install ${id}`);
      else log(`  - ${r.repo}: 无依赖，跳过`);
    }
  }

  // 写清单
  const manifest = {
    id,
    branch: id,
    createdAt: new Date().toISOString(),
    workspaceFile: path.basename(ctx.wsFile),
    workspaceDir: path.basename(rootDir),
    members: created.map((c) => ({
      repo: c.repo,
      main: c.mainAbs,
      path: path.relative(instRoot, c.memberDir),
      base: c.base,
    })),
  };
  writeManifest(instRoot, manifest);

  if (args.json) {
    log(
      JSON.stringify(
        {
          id,
          root: instRoot,
          workspaceDir: instWsDir,
          branch: id,
          members: manifest.members,
          install: installResults,
          seededCommit,
        },
        null,
        2
      )
    );
    return;
  }

  log("");
  log(`✓ worktree "${id}" 已就绪（${created.length} 个成员）`);
  log("");
  log(`  检出根目录   ${instRoot}`);
  log("");
  log(`  启动 opencode:`);
  log(`      opencode ${instWsDir}`);
  log(`      # 或`);
  log(`      cd ${instWsDir} && opencode`);
  log("");
  log(`  成员:`);
  for (const c of created) {
    log(`      ${c.repo.padEnd(14)} ${path.relative(instRoot, c.memberDir).padEnd(20)} @ ${id}`);
  }
  log("");
  log(`  下一步: /prepare  →  /opsx-propose <name>`);
}

function rollback(created, id, instRoot) {
  for (const c of [...created].reverse()) {
    try {
      git(c.mainAbs, ["worktree", "remove", "--force", c.memberDir]);
    } catch {
      /* ignore */
    }
    try {
      git(c.mainAbs, ["branch", "-D", id]);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(instRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// open / which
// ---------------------------------------------------------------------------

function cmdOpen(args) {
  const id = args._[0];
  validateId(id);
  const ctx = loadContext(args);
  const wt = resolveWorktreeOrFail(ctx.wtRoot, id);
  const target = path.join(wt.root, wt.manifest.workspaceDir);
  if (args.exec) {
    const r = spawnSync("opencode", [target], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  log(`opencode ${target}`);
}

function cmdWhich() {
  const enc = findEnclosingWorktree(process.cwd());
  if (enc) {
    const m = readManifest(enc.root);
    if (m) {
      log(`当前检出: worktree "${m.id}"（branch ${m.branch}）`);
      log(`检出根目录: ${enc.root}`);
      log(`workspace:  ${path.join(enc.root, m.workspaceDir)}`);
      return;
    }
    log(`当前检出: worktree（${enc.root}，清单缺失）`);
    return;
  }
  log("当前检出: 主树（非 worktree）");
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function cmdInstall(args) {
  const id = args._[0];
  validateId(id);
  const ctx = loadContext(args);
  const wt = resolveWorktreeOrFail(ctx.wtRoot, id);
  const members = wt.manifest.members.map((m) => ({ repo: m.repo, dir: memberAbs(wt.manifest, wt.root, m) }));
  log(`==> 安装依赖: worktree "${id}"`);
  const results = installMembers(members);
  let failed = 0;
  for (const r of results) {
    if (r.status === "ok") log(`  ✓ ${r.repo}: ${r.command}`);
    else if (r.status === "failed") {
      failed += 1;
      warn(`${r.repo}: 失败（${r.command}）\n${r.error ?? ""}`);
    } else log(`  - ${r.repo}: 无依赖，跳过`);
  }
  if (failed > 0) fail(`${failed} 个成员依赖安装失败。`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function cmdList(args) {
  const ctx = loadContext(args);
  const items = listWorktrees(ctx.wtRoot);
  if (args.json) {
    log(JSON.stringify(items.map((i) => ({ id: i.id, root: i.root, broken: i.broken, manifest: i.manifest })), null, 2));
    return;
  }
  if (items.length === 0) {
    log(`（无 worktree）检出根目录: ${ctx.wtRoot}`);
    return;
  }
  log(`检出根目录: ${ctx.wtRoot}`);
  log("");
  log(`  ${"ID".padEnd(16)} ${"分支".padEnd(16)} ${"成员".padEnd(6)} 状态`);
  for (const it of items) {
    if (it.broken) {
      log(`  ${it.id.padEnd(16)} ${"-".padEnd(16)} ${"-".padEnd(6)} 清单缺失`);
      continue;
    }
    const m = it.manifest;
    const missing = m.members.filter((mm) => !fs.existsSync(memberAbs(m, it.root, mm))).length;
    const status = missing > 0 ? `不完整（缺 ${missing} 个成员）` : "就绪";
    log(`  ${it.id.padEnd(16)} ${String(m.branch).padEnd(16)} ${String(m.members.length).padEnd(6)} ${status}`);
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function isWorktreeOf(mainDir, memberDir) {
  try {
    const out = git(mainDir, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .some((l) => samePath(l.slice("worktree ".length), memberDir));
  } catch {
    return false;
  }
}

function doctorOne(wt) {
  const problems = [];
  const notes = [];
  const m = wt.manifest;
  if (!m) {
    return { problems: ["清单缺失（.worktree.jsonc 不存在或无法解析）"], notes };
  }
  if (m.branch !== wt.id) problems.push(`清单 branch(${m.branch}) 与目录名(${wt.id}) 不一致`);

  for (const mm of m.members) {
    const dir = memberAbs(m, wt.root, mm);
    if (!fs.existsSync(dir)) {
      problems.push(`${mm.repo}: 成员目录不存在 ${dir}`);
      continue;
    }
    if (!isWorktreeOf(mm.main, dir)) {
      problems.push(`${mm.repo}: 不是 ${mm.main} 的 worktree（目录被移动或仓库不匹配）`);
      continue;
    }
    let branch = null;
    try {
      branch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      problems.push(`${mm.repo}: detached HEAD`);
      continue;
    }
    if (branch !== m.branch) problems.push(`${mm.repo}: 分支为 ${branch}，期望 ${m.branch}`);
    if (detectInstall(dir) && !fs.existsSync(path.join(dir, "node_modules"))) {
      problems.push(`${mm.repo}: 缺少 node_modules（运行 node scripts/worktree.mjs install ${wt.id}）`);
    }
  }
  return { problems, notes };
}

function cmdDoctor(args) {
  const ctx = loadContext(args);
  const id = args._[0];
  const targets = id ? [resolveWorktreeOrFail(ctx.wtRoot, id)] : listWorktrees(ctx.wtRoot);
  if (targets.length === 0) {
    log("（无 worktree 可检查）");
    return;
  }
  let failed = 0;
  for (const wt of targets) {
    const { problems } = doctorOne(wt);
    if (problems.length === 0) {
      log(`✓ ${wt.id}: 完整`);
      continue;
    }
    failed += 1;
    log(`✗ ${wt.id}:`);
    for (const p of problems) log(`    - ${p}`);
  }
  if (failed > 0) fail(`${failed} 个 worktree 不完整。`);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

function cmdRemove(args) {
  const id = args._[0];
  validateId(id);
  const ctx = loadContext(args);
  const wt = resolveWorktreeOrFail(ctx.wtRoot, id);
  const m = wt.manifest;

  const blockers = [];
  for (const mm of m.members) {
    const dir = memberAbs(m, wt.root, mm);
    if (!fs.existsSync(dir)) continue;
    try {
      const dirty = git(dir, ["status", "--porcelain"]);
      if (dirty) blockers.push(`${mm.repo}: 有未提交改动`);
    } catch {
      /* ignore */
    }
    try {
      const unmerged = git(dir, ["log", `${mm.base}..${m.branch}`, "--oneline"]);
      if (unmerged) blockers.push(`${mm.repo}: 有未合并到 ${mm.base} 的提交（${unmerged.split("\n").length} 个）`);
    } catch {
      /* base 不存在等情况忽略 */
    }
  }

  if (blockers.length > 0 && !args.force) {
    fail(
      `worktree "${id}" 存在以下未保存的改动，拒绝删除：\n` +
        blockers.map((b) => `  - ${b}`).join("\n") +
        `\n       确认已 push / 合并后，用 --force 强制删除。`
    );
  }

  log(`==> 删除 worktree "${id}"`);
  for (const mm of m.members) {
    const dir = memberAbs(m, wt.root, mm);
    if (fs.existsSync(dir)) {
      try {
        git(mm.main, ["worktree", "remove", "--force", dir]);
        log(`  ✓ 已移除 ${mm.repo}`);
      } catch (err) {
        warn(`${mm.repo}: worktree remove 失败（${String(err.message).split("\n")[0]}）`);
      }
    }
    try {
      git(mm.main, ["branch", "-D", m.branch]);
    } catch {
      /* 分支已不存在 */
    }
  }
  fs.rmSync(wt.root, { recursive: true, force: true });
  log(`  ✓ 已删除 ${wt.root}`);
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

function cmdPrune(args) {
  const ctx = loadContext(args);
  log("==> 清理各仓失效的 worktree 元数据");
  for (const f of ctx.folders) {
    if (!f.exists) {
      warn(`${f.originalName}: 路径不存在，跳过`);
      continue;
    }
    try {
      git(f.absPath, ["worktree", "prune"]);
      log(`  ✓ ${f.originalName}`);
    } catch (err) {
      warn(`${f.originalName}: prune 失败（${String(err.message).split("\n")[0]}）`);
    }
  }
  for (const it of listWorktrees(ctx.wtRoot)) {
    if (it.broken) {
      log(`  ! 目录 ${it.id} 无清单，可用 rm -rf 手动清理`);
      continue;
    }
    const missing = it.manifest.members.filter((mm) => !fs.existsSync(memberAbs(it.manifest, it.root, mm)));
    if (missing.length === it.manifest.members.length) {
      log(`  ! worktree "${it.id}" 全部成员已消失，可删除目录 ${it.root}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const COMMANDS = {
  new: cmdNew,
  open: cmdOpen,
  install: cmdInstall,
  list: cmdList,
  which: cmdWhich,
  doctor: cmdDoctor,
  remove: cmdRemove,
  prune: cmdPrune,
};

function main() {
  const argv = process.argv;
  const command = argv[2];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    fail(`未知命令: ${command}（可用: ${Object.keys(COMMANDS).join(", ")}）`);
  }
  const args = parseArgs(argv);
  handler(args);
}

main();
