#!/usr/bin/env node
/**
 * upgrade.mjs — 把已安装的 workspace 升级到远端最新版本
 *
 * 原则：只覆盖"框架拥有"的文件，绝不触碰"用户拥有"的文件。
 *   - 框架拥有（覆盖）：opencode/* → .opencode/*、scripts/*、AGENTS.md、
 *     openspec/{FRAMEWORK.md, config.template.yaml, templates/*}
 *   - 用户拥有（不碰）：*.code-workspace、opencode.jsonc、openspec/config.yaml、
 *     openspec/specs/**、openspec/changes/**、.opencode/agents/*-writer.md、
 *     .opencode/commands/opsx-*.md、.opencode/skills/**、README.md、.gitignore。
 *     package.json 仅合并"框架 scripts"与 version（见 template-map.mjs）。
 *
 * 用法:
 *   npm run upgrade                 # 取远端最新 tag，覆盖框架文件
 *   npm run upgrade -- --dry-run    # 只列出将变更的文件
 *   npm run upgrade -- --from github:tiasen/opencode-workspace-starter#v0.2.0
 *   npm run check:update            # 只检查是否有新版本（不写入）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { FRAMEWORK_DIRS, FRAMEWORK_FILES, FRAMEWORK_SCRIPTS, COPY_EXCLUDE } from "./template-map.mjs";

const DEFAULT_SOURCE = "github:tiasen/opencode-workspace-starter";
const REPO_URL = "https://github.com/tiasen/opencode-workspace-starter.git";
const SELF = path.dirname(fileURLToPath(import.meta.url));

const log = (m) => process.stdout.write(`${m}\n`);
const warn = (m) => process.stderr.write(`[warn] ${m}\n`);
function fail(msg) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(1);
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (f) => process.argv.includes(f);

function parseSemver(v) {
  const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

function resolveLatestTag() {
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", REPO_URL], { encoding: "utf8" });
    const tags = out
      .split("\n")
      .map((l) => (l.split("refs/tags/")[1] || "").replace(/\^\{\}$/, "").trim())
      .filter((t) => parseSemver(t));
    if (tags.length === 0) return null;
    tags.sort(cmp);
    const latest = tags[tags.length - 1];
    return latest.startsWith("v") ? latest : `v${latest}`;
  } catch {
    return null;
  }
}

function packAndExtract(spec) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ows-upgrade-"));
  const dest = path.join(tmp, "pkg");
  fs.mkdirSync(dest, { recursive: true });
  let tgzName;
  try {
    tgzName = execFileSync("npm", ["pack", spec, "--pack-destination", tmp, "--silent"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .pop();
  } catch (e) {
    fail(`npm pack 失败: ${spec}\n${e.message}`);
  }
  const tgz = path.join(tmp, tgzName);
  if (!fs.existsSync(tgz)) fail(`未找到打包产物: ${tgz}`);
  execFileSync("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"], { stdio: "inherit" });
  return { tmp, pkgDir: dest };
}

function walk(srcDir, destDir, onFile) {
  for (const entry of fs.readdirSync(srcDir)) {
    if (COPY_EXCLUDE.has(entry)) continue;
    const s = path.join(srcDir, entry);
    const d = path.join(destDir, entry);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      walk(s, d, onFile);
    } else if (st.isFile()) {
      onFile(s, d);
    }
  }
}

function collectPlan(pkgDir, root) {
  const plan = [];
  for (const [fromDir, toDir] of FRAMEWORK_DIRS) {
    const srcDir = path.join(pkgDir, fromDir);
    if (!fs.existsSync(srcDir)) continue;
    walk(srcDir, path.join(root, toDir), (s, d) => plan.push({ src: s, dest: d }));
  }
  for (const [fromFile, toFile] of FRAMEWORK_FILES) {
    const s = path.join(pkgDir, fromFile);
    if (fs.existsSync(s)) plan.push({ src: s, dest: path.join(root, toFile) });
  }
  return plan;
}

function readPkg(pkgDir) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
}

function main() {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, "package.json"))) {
    fail(`当前目录不是 workspace-root（找不到 package.json）: ${root}`);
  }
  const userPkgPath = path.join(root, "package.json");
  const userPkg = JSON.parse(fs.readFileSync(userPkgPath, "utf8"));
  const localVersion = userPkg.version ?? "0.0.0";

  const from = arg("--from", null);
  let spec;
  let targetTag = null;
  if (from) {
    spec = from;
  } else {
    targetTag = resolveLatestTag();
    if (!targetTag) {
      warn(`无法获取远端 tags（离线或仓库未打 tag），改用默认分支。`);
      spec = DEFAULT_SOURCE;
    } else {
      spec = `${DEFAULT_SOURCE}#${targetTag}`;
    }
  }

  // ---- check 模式：只报告 ----
  if (has("--check")) {
    log(`本地版本: ${localVersion}`);
    log(`远端版本: ${targetTag ? targetTag.replace(/^v/, "") : "未知（无可用 tag）"}`);
    if (targetTag && cmp(targetTag.replace(/^v/, ""), localVersion) > 0) {
      log(`→ 有新版本可用。运行 \`npm run upgrade\` 升级。`);
    } else if (targetTag) {
      log(`→ 已是最新。`);
    }
    return;
  }

  const { tmp, pkgDir } = packAndExtract(spec);
  const fwPkg = readPkg(pkgDir);
  const newVersion = fwPkg.version ?? localVersion;

  log(`来源: ${spec}`);
  log(`版本: ${localVersion} → ${newVersion}`);

  const plan = collectPlan(pkgDir, root);

  if (has("--dry-run")) {
    log(`\n[dry-run] 将覆盖 ${plan.length} 个框架文件:`);
    for (const p of plan) log(`  ${path.relative(root, p.dest)}`);
    log(`\n[dry-run] package.json: version → ${newVersion}，合并框架 scripts（保留其他字段）`);
    log(`[dry-run] 不触碰: ${["opencode.jsonc", "openspec/config.yaml", "*.code-workspace", ".opencode/agents/*-writer.md"].join(", ")} 等用户文件`);
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }

  let written = 0;
  for (const p of plan) {
    // AGENTS.md 覆盖前备份
    if (path.basename(p.dest) === "AGENTS.md" && fs.existsSync(p.dest)) {
      fs.copyFileSync(p.dest, `${p.dest}.bak`);
    }
    fs.mkdirSync(path.dirname(p.dest), { recursive: true });
    fs.copyFileSync(p.src, p.dest);
    try {
      fs.chmodSync(p.dest, fs.statSync(p.src).mode);
    } catch {
      /* ignore */
    }
    written += 1;
  }

  // 合并 package.json：只动 version 与框架 scripts
  const merged = {
    ...userPkg,
    version: newVersion,
    scripts: { ...(userPkg.scripts ?? {}), ...FRAMEWORK_SCRIPTS },
  };
  fs.writeFileSync(userPkgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  fs.rmSync(tmp, { recursive: true, force: true });

  log(`\n已覆盖 ${written} 个框架文件，package.json 已更新到 ${newVersion}。`);
  if (fs.existsSync(path.join(root, "scripts", "sync-config.mjs"))) {
    log(`同步 openspec/config.yaml ...`);
    try {
      execFileSync(process.execPath, [path.join(root, "scripts", "sync-config.mjs")], { stdio: "inherit" });
    } catch {
      warn("sync:config 失败，请手动运行 npm run sync:config。");
    }
  }
  log(`\n完成。建议接着运行: npm run init -- --yes（刷新 agents / opencode.jsonc）`);
  void SELF;
}

main();
