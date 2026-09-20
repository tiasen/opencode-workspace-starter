#!/usr/bin/env node
/**
 * bin/create.mjs — scaffolding 入口（npx / 本地两用）
 *
 * 用法:
 *   npx github:YOUR_USER/opencode-workspace-starter [target-dir] [options]
 *   npx -y github:YOUR_USER/opencode-workspace-starter my-project --init
 *   node bin/create.mjs my-project --force
 *
 * 路径映射（关键）:
 *   源码模板面向用户的目录是 `opencode/`（无点），scaffold 时映射为 `.opencode/`；
 *   `template.gitignore` → `.gitignore`；`package.json` 由 buildUserPackageJson 生成
 *   （version = 框架版本，name = 目标目录名）。源码自身的 `.opencode/`、`bin/`、
 *   `.github/`、`.githooks/` 属于开发侧，不复制给用户。映射清单见 scripts/template-map.mjs。
 *
 * 行为:
 *   1. 递归复制模板到 target-dir（跳过开发侧目录）。
 *   2. 目标目录不存在则创建；已存在时：仅含预置 `*.code-workspace` / `.git` 可直接合并；
 *      含其他文件需 --force（覆盖与模板同名文件）；绝不覆盖已存在的 `*.code-workspace`。
 *   3. 无预置 workspace 文件时，由 template.code-workspace 复制出 <target-dir 名>.code-workspace。
 *   4. 加 --init 则在目标目录运行 scripts/init.mjs --yes。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { RENAME, SCAFFOLD_SKIP, COPY_EXCLUDE, buildUserPackageJson } from "../scripts/template-map.mjs";

const TEMPLATE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROTECTED_PATTERNS = [/\.code-workspace$/];
const TOLERATED_NAMES = new Set([".git", ".DS_Store"]);

const log = (m) => process.stdout.write(`${m}\n`);
function fail(msg) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(1);
}
const isProtected = (name) => TOLERATED_NAMES.has(name) || PROTECTED_PATTERNS.some((re) => re.test(name));

function printHelp() {
  log(`用法: create-opencode-workspace [target-dir] [--force] [--init] [--help]`);
  log(`  target-dir   目标目录（默认: ./opencode-workspace）`);
  log(`               可预先放入你的 .code-workspace（会被保留，绝不覆盖），无需 --force`);
  log(`  --force      目标目录含非 workspace 文件时仍继续（覆盖与模板同名文件）`);
  log(`  --init       拷贝完成后自动运行 scripts/init.mjs --yes`);
  log(`  --help, -h   显示本帮助`);
  log(`示例:`);
  log(`  npx github:YOUR_USER/opencode-workspace-starter my-project`);
  log(`  npx -y github:YOUR_USER/opencode-workspace-starter my-project --init`);
}

function parseArgs(argv) {
  const args = { target: null, force: false, init: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--init") args.init = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("--")) fail(`未知参数: ${a}（查看 --help）`);
    else if (args.target === null) args.target = a;
    else fail(`多余的位置参数: ${a}（查看 --help）`);
  }
  return args;
}

/** 递归复制；不覆盖已存在的 workspace 文件；返回 {copied, skipped}。 */
function copyEntry(src, dest, acc) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (COPY_EXCLUDE.has(entry)) continue;
      copyEntry(path.join(src, entry), path.join(dest, entry), acc);
    }
    return;
  }
  if (!stat.isFile()) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && PROTECTED_PATTERNS.some((re) => re.test(dest))) {
    acc.skipped += 1;
    return;
  }
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, stat.mode);
  } catch {
    /* Windows 等平台忽略 */
  }
  acc.copied += 1;
}

function scaffold(targetDir) {
  const acc = { copied: 0, skipped: 0 };
  for (const entry of fs.readdirSync(TEMPLATE_ROOT)) {
    if (SCAFFOLD_SKIP.has(entry) || entry.endsWith(".tgz")) continue;
    const destName = RENAME[entry] ?? entry;
    copyEntry(path.join(TEMPLATE_ROOT, entry), path.join(targetDir, destName), acc);
  }
  // 用户 package.json：version = 框架版本，name = 目标目录名
  const fwPkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE_ROOT, "package.json"), "utf8"));
  const userPkg = buildUserPackageJson(path.basename(targetDir), fwPkg.version);
  fs.writeFileSync(path.join(targetDir, "package.json"), `${JSON.stringify(userPkg, null, 2)}\n`, "utf8");
  acc.copied += 1;
  return acc;
}

function main() {
  const args = parseArgs(process.argv);
  const targetDir = path.resolve(process.cwd(), args.target ?? "opencode-workspace");

  log(`模板来源: ${TEMPLATE_ROOT}`);
  log(`目标目录: ${targetDir}`);

  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir).filter((e) => !TOLERATED_NAMES.has(e) || e === ".git");
    const kept = entries.filter((e) => isProtected(e));
    const rest = entries.filter((e) => !isProtected(e));
    const shown = kept.filter((e) => e !== ".git");
    if (shown.length > 0) log(`检测到预置文件（将保留，不覆盖）: ${shown.join(", ")}`);
    if (rest.length > 0 && !args.force) {
      fail(
        `目标目录已存在以下非 workspace 文件（${rest.length} 项）: ${rest.join(", ")}。` +
          `换一个目录，或加 --force 继续（会覆盖与模板同名的文件）。`
      );
    }
    if (rest.length > 0 && args.force) log(`--force 已指定，将覆盖与模板同名的文件，其余已有文件保留。`);
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const { copied, skipped } = scaffold(targetDir);
  log(`已拷贝 ${copied} 个文件。`);
  if (skipped > 0) log(`已跳过 ${skipped} 个已存在的 workspace 文件（保留你的版本）。`);

  const baseName = path.basename(targetDir);
  const namedWorkspace = path.join(targetDir, `${baseName}.code-workspace`);
  const templateWorkspace = path.join(targetDir, "template.code-workspace");
  const preexisting = fs
    .readdirSync(targetDir)
    .filter((f) => f.endsWith(".code-workspace") && f !== "template.code-workspace");
  let activeWorkspace;
  if (preexisting.length > 0) {
    activeWorkspace = preexisting.sort()[0];
    log(`使用预置的 workspace 文件: ${activeWorkspace}（跳过自动生成）。`);
  } else if (fs.existsSync(templateWorkspace) && !fs.existsSync(namedWorkspace)) {
    fs.copyFileSync(templateWorkspace, namedWorkspace);
    activeWorkspace = `${baseName}.code-workspace`;
    log(`已生成 ${activeWorkspace}（由 template.code-workspace 复制，请编辑其中的 folders）。`);
  } else {
    activeWorkspace = `${baseName}.code-workspace`;
  }

  if (args.init) {
    log(`运行 scripts/init.mjs --yes ...`);
    const r = spawnSync(process.execPath, ["scripts/init.mjs", "--yes"], { cwd: targetDir, stdio: "inherit" });
    if (r.status !== 0) fail(`init 未成功（退出码 ${r.status}），请进入 ${targetDir} 手动运行 npm run init。`);
  }

  log(``);
  log(`完成。下一步:`);
  const rel = path.relative(process.cwd(), targetDir);
  const cdTarget = rel === "" ? "." : rel.startsWith("..") ? targetDir : rel;
  log(`  1. cd ${cdTarget}`);
  log(`  2. 检查 ${activeWorkspace} 的 folders 是否指向真实仓库路径`);
  log(`  3. npm run init -- --yes`);
  log(`  4. 在 workspace-root 运行 opencode，通过 /prepare 确认各仓就位`);
}

main();
