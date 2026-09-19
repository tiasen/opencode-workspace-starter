#!/usr/bin/env node
/**
 * init.mjs — opencode-workspace-starter 初始化脚本
 *
 * 功能:
 *   1. 环境检测（Node 版本、git、opencode CLI 可用性）
 *   2. 解析 VS Code `.code-workspace`（唯一的目录配置源）
 *   3. 路径规范化（path.resolve + POSIX 统一，防止 `..` 通配符错位）
 *   4. 为每个非 workspace-root 的 folder 生成 agents/{name}-writer.jsonc（mode: subagent，物理锁定单仓）
 *   5. 生成 agents/reviewer.jsonc（mode: subagent，只写 review-report.md）
 *   6. 生成/更新 opencode.jsonc（Orchestrator 主配置，含 permission.task 授权）
 *
 * 零依赖：仅使用 Node 内置模块 fs / path / child_process / readline / url / os。
 *
 * 用法:
 *   node scripts/init.mjs [--workspace <path>] [--root <path>] [--yes] [--dry-run]
 *
 *   --workspace <path>  .code-workspace 文件路径（默认依次查找
 *                        ./template.code-workspace、./*.code-workspace）
 *   --root <path>       workspace-root 目录（默认: .code-workspace 所在目录，
 *                        若 workspace 在仓库根则为 process.cwd()）
 *   --yes               非交互模式，存在同名 Agent 文件时直接覆盖
 *   --dry-run           仅打印将要生成的内容，不写文件
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MIN_NODE_MAJOR = 18;
const STARTER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[warn] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exitCode = 1;
}

/** 将任意路径转为 POSIX 风格（正斜杠），保证通配符在各平台一致。 */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 去掉 JSONC 注释（// 与 block 注释），保留字符串内的 // 不被误伤。 */
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1] ?? "";
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i += 2;
      } else {
        if (c === "\n") out += c;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n;
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function parseArgs(argv) {
  const args = { workspace: null, root: null, yes: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workspace" && argv[i + 1]) {
      args.workspace = argv[++i];
    } else if (a.startsWith("--workspace=")) {
      args.workspace = a.slice("--workspace=".length);
    } else if (a === "--root" && argv[i + 1]) {
      args.root = argv[++i];
    } else if (a.startsWith("--root=")) {
      args.root = a.slice("--root=".length);
    } else if (a === "--yes" || a === "-y") {
      args.yes = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      warn(`未知参数已忽略: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  log(`用法: node scripts/init.mjs [--workspace <path>] [--root <path>] [--yes] [--dry-run]`);
  log(`  --workspace  .code-workspace 文件路径`);
  log(`  --root       workspace-root（Agent 相对路径的解析基准，默认与 starter 根相同）`);
  log(`  --yes        覆盖已存在的 Agent 文件时不提示`);
  log(`  --dry-run    仅预览，不写文件`);
}

function askConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === "y" || v === "yes" || v === "");
    });
  });
}

function commandExists(cmd) {
  const probe = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. 环境检测
// ---------------------------------------------------------------------------

function checkEnvironment() {
  log("==> 1/5 环境检测");
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    fail(`Node 版本过低: ${process.versions.node}，需要 >= ${MIN_NODE_MAJOR}`);
    process.exit(1);
  }
  log(`  Node ${process.versions.node} OK (${process.platform}/${process.arch})`);

  if (commandExists("git")) {
    try {
      const v = execSync("git --version", { encoding: "utf8" }).trim();
      log(`  ${v} OK`);
    } catch {
      warn("git 存在但无法获取版本，继续执行。");
    }
  } else {
    warn("未检测到 git，commit hash 校验（/prepare）将不可用，建议安装。");
  }

  if (commandExists("opencode")) {
    try {
      const v = execSync("opencode --version", { encoding: "utf8" }).trim();
      log(`  opencode ${v} OK`);
    } catch {
      log("  opencode CLI 已安装（版本查询失败，不影响继续）。");
    }
  } else {
    warn("未检测到 opencode CLI，Agent 配置仍可生成，但 Task 调度需安装后验证。");
  }
}

// ---------------------------------------------------------------------------
// 2. 解析 .code-workspace
// ---------------------------------------------------------------------------

function findWorkspaceFile(explicit) {
  if (explicit) {
    const p = path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(p)) {
      fail(`指定的 workspace 文件不存在: ${p}`);
      process.exit(1);
    }
    return p;
  }
  // 扫描 starter 根目录下的 *.code-workspace。
  // 用户自建的 workspace 文件优先于 template（scaffolding 后目录里通常两者并存，
  // 用户编辑的是自建的那份，不应被 template 抢占）。
  // 多个自建文件并存时，优先与目录同名的那个（create.mjs 按此约定生成），其次按字母序。
  const named = [];
  try {
    for (const f of fs.readdirSync(STARTER_ROOT)) {
      if (f.endsWith(".code-workspace") && f !== "template.code-workspace") {
        named.push(path.join(STARTER_ROOT, f));
      }
    }
  } catch {
    // 忽略读取错误，后续报错
  }
  const preferredName = `${path.basename(STARTER_ROOT)}.code-workspace`;
  named.sort((a, b) => {
    const ap = path.basename(a) === preferredName ? 0 : 1;
    const bp = path.basename(b) === preferredName ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const candidates = [...named];
  const template = path.join(STARTER_ROOT, "template.code-workspace");
  if (fs.existsSync(template) && !candidates.includes(template)) {
    candidates.push(template);
  }
  if (candidates.length === 0) {
    fail("未找到 .code-workspace 文件。请使用 --workspace 指定，或从 template.code-workspace 复制一份。");
    process.exit(1);
  }
  if (candidates.length > 1) {
    log(`  发现多个 workspace 文件，使用第一个: ${candidates[0]}`);
    log(`  候选列表: ${candidates.join(", ")}`);
  }
  return candidates[0];
}

function loadWorkspace(workspaceFile) {
  log("==> 2/5 解析 workspace");
  log(`  workspace 文件: ${workspaceFile}`);
  const raw = fs.readFileSync(workspaceFile, "utf8");
  let data;
  try {
    data = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    fail(`workspace 文件 JSON 解析失败: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(data.folders) || data.folders.length === 0) {
    fail("workspace 文件缺少非空 folders 数组。");
    process.exit(1);
  }
  return data;
}

// ---------------------------------------------------------------------------
// 3. 路径规范化（关键逻辑）
// ---------------------------------------------------------------------------

/**
 * 将 workspace folder.path 规范化为「相对 workspace-root 的 POSIX 路径」。
 *
 * 步骤:
 *   a. 以 .code-workspace 文件所在目录为基准 resolve 原始 path
 *      （VS Code 语义：相对路径相对 workspace 文件位置）。
 *   b. 以 workspace-root（默认为 starter 根，即 opencode.jsonc 所在目录）为基准
 *      计算 relative 路径。
 *   c. 转为 POSIX 风格，`.` 保持为 `.`。
 *   d. 对 workspace-root 自身返回 `.`，其余返回如 `../frontend` 的相对形式。
 *
 * 这样生成的 `{rel}/**` 通配符与 Orchestrator 运行时的 cwd 一致，
 * 不会因 `..` 解析错位导致越权或误拦截。
 */
function normalizeFolderPath(folderPath, workspaceFileDir, workspaceRoot) {
  const trimmed = String(folderPath).trim();
  if (trimmed === "" || trimmed === ".") {
    // 相对 workspace 文件的 "." —— 需要先 resolve 再 relative，避免基准不同
    const abs = path.resolve(workspaceFileDir, trimmed);
    const rel = path.relative(workspaceRoot, abs);
    if (rel === "") return ".";
    return toPosix(rel) || ".";
  }
  const abs = path.resolve(workspaceFileDir, trimmed);
  const rel = path.relative(workspaceRoot, abs);
  if (rel === "") return ".";
  const posix = toPosix(rel);
  return posix;
}

function sanitizeAgentName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "repo";
}

function buildFolderModels(folders, workspaceFileDir, workspaceRoot) {
  const models = [];
  const seenNames = new Set();
  for (const f of folders) {
    if (!f || typeof f.path !== "string" || typeof f.name !== "string") {
      warn(`跳过非法 folder 条目: ${JSON.stringify(f)}`);
      continue;
    }
    const name = sanitizeAgentName(f.name);
    if (seenNames.has(name)) {
      warn(`folder name 重复 "${f.name}"（规范化为 "${name}"），已跳过重复项。`);
      continue;
    }
    seenNames.add(name);
    const rel = normalizeFolderPath(f.path, workspaceFileDir, workspaceRoot);
    const abs = path.resolve(workspaceFileDir, String(f.path).trim() || ".");
    const exists = fs.existsSync(abs);
    models.push({
      originalName: f.name,
      name,
      rawPath: f.path,
      relPath: rel,
      absPath: abs,
      exists,
      isRoot: rel === "." || rel === "",
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// 4/5. 生成 Agent 配置与 opencode.jsonc
// ---------------------------------------------------------------------------

function writerConfig(folder) {
  // relPath 为 "." 的 folder 不应生成 writer（那是 workspace-root 本身）
  const scope = folder.relPath === "." ? "." : `${folder.relPath}/**`;
  const instructions = ["AGENTS.md"];
  // workspace-root 的 AGENTS.md 无法用相对路径指向子仓时，保留占位引用；
  // 若子仓 AGENTS.md 相对可达则引用它，否则仅保留根 AGENTS.md。
  // 此处生成 `{relPath}/AGENTS.md` 形式，由 Orchestrator 按约定解析。
  if (folder.relPath !== ".") {
    instructions.push(`${folder.relPath}/AGENTS.md`);
  }
  return {
    mode: "subagent",
    description: `负责修改 ${folder.originalName} 仓库代码与契约实现的 Sub-Agent`,
    permission: {
      edit: {
        [scope]: "allow",
      },
      external_directory: {
        "openspec/**": "allow",
        "../**": "allow",
      },
    },
    instructions,
  };
}

function reviewerConfig() {
  return {
    mode: "subagent",
    description: "负责跨仓一致性审查的 Reviewer Agent",
    permission: {
      edit: {
        "openspec/changes/*/review-report.md": "allow",
        "**": "deny",
      },
      external_directory: {
        "../**": "allow",
      },
    },
  };
}

function orchestratorConfig(writerNames) {
  const task = {};
  for (const n of writerNames) {
    task[`${n}-writer`] = "allow";
  }
  task["reviewer"] = "allow";
  return {
    permission: {
      edit: {
        "openspec/**": "allow",
        "**": "deny",
      },
      external_directory: {
        "../**": "allow",
      },
      task,
      bash: {
        "opencode *": "allow",
        "git status": "allow",
      },
    },
    instructions: ["AGENTS.md"],
  };
}

function toJsoncWithHeader(obj, headerLines) {
  const header = headerLines.map((l) => `// ${l}`).join("\n");
  return `${header}\n${JSON.stringify(obj, null, 2)}\n`;
}

async function writeFileSafe(filePath, content, opts) {
  if (fs.existsSync(filePath) && !opts.yes && !opts.dryRun) {
    const ok = await askConfirm(`文件已存在，是否覆盖? ${filePath} [Y/n] `);
    if (!ok) {
      log(`  跳过（保留现有文件）: ${filePath}`);
      return false;
    }
  }
  if (opts.dryRun) {
    log(`  [dry-run] 将写入: ${filePath}`);
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  log(`  已生成: ${filePath}`);
  return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const workspaceRoot = args.root
    ? path.resolve(process.cwd(), args.root)
    : STARTER_ROOT;

  log("opencode-workspace-starter init");
  log(`  starter 根目录: ${STARTER_ROOT}`);
  log(`  workspace-root: ${workspaceRoot}`);
  log(`  平台家目录: ${os.homedir()}`);

  checkEnvironment();

  const workspaceFile = findWorkspaceFile(args.workspace);
  const workspaceFileDir = path.dirname(workspaceFile);
  const ws = loadWorkspace(workspaceFile);

  log("==> 3/5 路径规范化");
  const folders = buildFolderModels(ws.folders, workspaceFileDir, workspaceRoot);
  if (folders.length === 0) {
    fail("没有可用的 folder 条目，终止。");
    process.exit(1);
  }
  for (const f of folders) {
    const flag = f.exists ? "存在" : "不存在（可能尚未 clone，仍生成配置）";
    log(`  folder "${f.originalName}": raw="${f.rawPath}" rel="${f.relPath}" abs="${f.absPath}" [${flag}]${f.isRoot ? " [workspace-root]" : ""}`);
    if (!f.exists) {
      warn(`路径不存在: ${f.absPath}，请确认仓库已 clone 到该位置。`);
    }
  }

  const writers = folders.filter((f) => !f.isRoot);
  if (writers.length === 0) {
    warn("除 workspace-root 外没有其他 folder，仅生成 reviewer 与 opencode.jsonc。");
  }

  log("==> 4/5 生成 Sub-Agent 配置");
  const agentsDir = path.join(workspaceRoot, "agents");
  const writerNames = [];
  for (const w of writers) {
    const cfg = writerConfig(w);
    const fileName = `${w.name}-writer.jsonc`;
    const filePath = path.join(agentsDir, fileName);
    const content = toJsoncWithHeader(cfg, [
      `${w.originalName} Writer Sub-Agent（由 scripts/init.mjs 自动生成）`,
      `作用域: ${w.relPath === "." ? "." : `${w.relPath}/**`}（仅可写本仓）`,
      `重新运行 npm run init 可重新生成，不要手动改路径。`,
    ]);
    if (args.dryRun) {
      log(`  [dry-run] 将写入: ${filePath}`);
      log(content);
    } else {
      await writeFileSafe(filePath, content, args);
    }
    writerNames.push(w.name);
  }

  const reviewer = reviewerConfig();
  const reviewerPath = path.join(agentsDir, "reviewer.jsonc");
  const reviewerContent = toJsoncWithHeader(reviewer, [
    "Reviewer Sub-Agent（由 scripts/init.mjs 自动生成）",
    "只读所有仓，只写 openspec/changes/*/review-report.md",
  ]);
  if (args.dryRun) {
    log(`  [dry-run] 将写入: ${reviewerPath}`);
    log(reviewerContent);
  } else {
    await writeFileSafe(reviewerPath, reviewerContent, args);
  }

  log("==> 5/5 生成/更新 Orchestrator opencode.jsonc");
  const orch = orchestratorConfig(writerNames);
  const orchPath = path.join(workspaceRoot, "opencode.jsonc");
  const orchContent = toJsoncWithHeader(
    orch,
    [
      'Root Orchestrator Agent (Primary) —— 跨仓架构编排器',
      `由 scripts/init.mjs 自动生成。writers: [${writerNames.join(", ") || "(none)"}]`,
      `workspace: ${path.basename(workspaceFile)}`,
    ]
  );
  if (args.dryRun) {
    log(`  [dry-run] 将写入: ${orchPath}`);
    log(orchContent);
  } else {
    await writeFileSafe(orchPath, orchContent, args);
  }

  log("");
  log("完成。下一步:");
  log("  1. 检查 agents/ 下生成的 *-writer.jsonc 作用域是否正确");
  log("  2. 在 workspace-root 运行 /prepare 生成 openspec/repo-context.md");
  log("  3. 新建 Spec Change：复制 openspec/changes/template 为 openspec/changes/<name>/");
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
