#!/usr/bin/env node
/**
 * bin/create.mjs — scaffolding 入口（npx / 本地两用）
 *
 * 用法:
 *   npx github:YOUR_USER/opencode-workspace-starter [target-dir] [options]
 *   npx -y github:YOUR_USER/opencode-workspace-starter my-project --init
 *   node bin/create.mjs my-project --force
 *
 * 说明:
 *   npx 支持把 GitHub 仓库当作包来运行（无需发布到 npm）:
 *     npx <user>/<repo>            从默认分支拉取，打包后运行 package.json 中唯一的 bin
 *     npx github:<user>/<repo>#<branch>  指定分支 / tag / commit
 *   仓库根目录必须有带 `bin` 字段的 package.json（本文件即由该 bin 指向）。
 *   私有仓库需要本机 git/ssh 凭证；公开仓库直接可用。npx 会把包缓存起来，
 *   下次运行可能用缓存，加 `--ignore-existing` 可强制重新拉取。
 *
 * 行为:
 *   1. 把模板根目录（本文件所在包的根）递归拷贝到 target-dir
 *      （跳过 .git、node_modules）。
 *   2. 若目标目录不存在则创建；若已存在：
 *      - 仅含有预置的 `*.code-workspace` / `.git` 时直接合并，无需 --force；
 *      - 含有其他文件时，需加 --force 才会继续（会覆盖与模板同名的文件）。
 *      拷贝时绝不覆盖目标目录中已存在的 `*.code-workspace`（用户预置的配置源）。
 *   3. 仅当目标目录没有任何非 template 的 workspace 文件时，才自动把
 *      template.code-workspace 复制为 <target-dir 名>.code-workspace。
 *   4. 加 --init 则拷贝完成后直接在目标目录运行 scripts/init.mjs --yes。
 *   5. 最后打印后续步骤（编辑 workspace → npm run init → /prepare）。
 *
 * 推荐流程（workspace 文件先行）:
 *   mkdir my-project && cd my-project
 *   （放入你的 my-project.code-workspace）
 *   npx github:YOUR_USER/opencode-workspace-starter . --init
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TEMPLATE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXCLUDE_NAMES = new Set([".git", "node_modules", ".DS_Store", ".opencode-cache"]);

// 目标目录中允许预先存在的条目：
// - *.code-workspace：用户预置的目录配置源（唯一的目录配置源），必须保留，绝不覆盖；
// - .git：允许 scaffolding 到已有的 git 仓库工作区中。
const PROTECTED_PATTERNS = [/\.code-workspace$/];
const TOLERATED_NAMES = new Set([".git", ".DS_Store"]);

function isProtected(name) {
  if (TOLERATED_NAMES.has(name)) return true;
  return PROTECTED_PATTERNS.some((re) => re.test(name));
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  log(`用法: create-opencode-workspace [target-dir] [--force] [--init] [--help]`);
  log(`  target-dir   目标目录（默认: ./opencode-workspace，不存在则创建）`);
  log(`               目录中可预先放入你的 .code-workspace 文件（会被保留，绝不覆盖），无需 --force`);
  log(`  --force      目标目录含有非 workspace 文件时仍继续（会覆盖与模板同名的文件）`);
  log(`  --init       拷贝完成后自动运行 scripts/init.mjs --yes`);
  log(`  --help, -h   显示本帮助`);
  log(``);
  log(`示例:`);
  log(`  npx github:YOUR_USER/opencode-workspace-starter my-project`);
  log(`  npx -y github:YOUR_USER/opencode-workspace-starter my-project --init`);
  log(`  mkdir my-project && cd my-project  # workspace 文件先行：先放好 my-project.code-workspace`);
  log(`  npx github:YOUR_USER/opencode-workspace-starter . --init`);
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
    } else if (a.startsWith("--")) {
      fail(`未知参数: ${a}（查看 --help）`);
    } else if (args.target === null) {
      args.target = a;
    } else {
      fail(`多余的位置参数: ${a}（查看 --help）`);
    }
  }
  return args;
}

function copyTree(src, dest) {
  let fileCount = 0;
  let dirCount = 0;
  let skippedCount = 0;
  const stack = [{ src, dest }];
  while (stack.length > 0) {
    const { src: s, dest: d } = stack.pop();
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      dirCount += 1;
      for (const entry of fs.readdirSync(s)) {
        if (EXCLUDE_NAMES.has(entry)) continue;
        stack.push({ src: path.join(s, entry), dest: path.join(d, entry) });
      }
    } else if (stat.isFile()) {
      // 已存在的 workspace 文件是用户预置的配置源，绝不覆盖
      if (fs.existsSync(d) && PROTECTED_PATTERNS.some((re) => re.test(d))) {
        skippedCount += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      // 保留可执行位（init.mjs 等脚本）
      try {
        fs.chmodSync(d, stat.mode);
      } catch {
        // Windows 等平台忽略 chmod 失败
      }
      fileCount += 1;
    }
  }
  return { fileCount, dirCount, skippedCount };
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
    if (kept.length > 0) {
      // .git 仅用于提示，不计入"已有内容"
      const shown = kept.filter((e) => e !== ".git");
      if (shown.length > 0) {
        log(`检测到预置文件（将保留，不覆盖）: ${shown.join(", ")}`);
      }
    }
    if (rest.length > 0 && !args.force) {
      fail(
        `目标目录已存在以下非 workspace 文件（${rest.length} 项）: ${rest.join(", ")}。` +
          `换一个目录，或加 --force 继续（会覆盖与模板同名的文件）。`
      );
    }
    if (rest.length > 0 && args.force) {
      log(`--force 已指定，将覆盖与模板同名的文件，其余已有文件保留。`);
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const { fileCount, dirCount, skippedCount } = copyTree(TEMPLATE_ROOT, targetDir);
  log(`已拷贝 ${fileCount} 个文件（${dirCount} 个目录）。`);
  if (skippedCount > 0) {
    log(`已跳过 ${skippedCount} 个已存在的 workspace 文件（保留你的版本）。`);
  }

  // 仅当目标目录没有任何非 template 的 workspace 文件时，才附带生成一份
  // 以目标目录命名的 workspace 文件；用户预置的 workspace 优先，不再画蛇添足。
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
    const r = spawnSync(process.execPath, ["scripts/init.mjs", "--yes"], {
      cwd: targetDir,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      fail(`init 未成功（退出码 ${r.status}），请进入 ${targetDir} 手动运行 npm run init。`);
    }
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
