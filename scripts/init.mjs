#!/usr/bin/env node
/**
 * init.mjs — opencode-workspace-starter 初始化脚本
 *
 * 功能:
 *   1. 环境检测（Node 版本、git、opencode CLI 可用性）
 *   2. 解析 VS Code `.code-workspace`（唯一的目录配置源）
 *   3. 路径规范化（path.resolve + POSIX 统一，防止 `..` 通配符错位）
 *   4. 为每个非 workspace-root 的 folder 生成 .opencode/agents/{name}-writer.md
 *      （Markdown + frontmatter，mode: subagent，物理锁定单仓；opencode 只识别此路径格式）
 *   5. 生成 .opencode/agents/reviewer.md（mode: subagent，只写 review-report.md）
 *   6. 生成/更新 opencode.jsonc（Orchestrator 主配置，含 permission.task 授权）
 *
 * 零依赖：仅使用 Node 内置模块 fs / path / child_process / readline / url / os。
 *
 * 用法:
 *   node scripts/init.mjs [--workspace <path>] [--root <path>] [--yes] [--dry-run]
 *
 *   --workspace <path>  .code-workspace 文件路径（默认：用户自建优先、
 *                        template.code-workspace 兜底；多文件并存时优先与目录同名者）
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
import { syncConfig } from "./sync-config-lib.mjs";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MIN_NODE_MAJOR = 24;
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
  const args = { workspace: null, root: null, yes: false, dryRun: false, skipOpenspec: false };
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
    } else if (a === "--skip-openspec") {
      args.skipOpenspec = true;
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
  log(`用法: node scripts/init.mjs [--workspace <path>] [--root <path>] [--yes] [--dry-run] [--skip-openspec]`);
  log(`  --workspace  .code-workspace 文件路径`);
  log(`  --root       workspace-root（Agent 相对路径的解析基准，默认与 starter 根相同）`);
  log(`  --yes        覆盖已存在的 Agent 文件时不提示`);
  log(`  --dry-run    仅预览，不写文件`);
  log(`  --skip-openspec  跳过最后的 OpenSpec 配置同步（离线/CI 用）`);
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
  log("==> 1/6 环境检测");
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
    warn("未检测到 git，/prepare 的工作区洁净度检查将不可用，建议安装。");
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
  log("==> 2/6 解析 workspace");
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
    // VS Code 规范里 folder 只有 path 必填，name 可选。
    // name 缺失时模仿 VS Code：取解析后绝对路径的 basename 作为显示名。
    if (!f || typeof f.path !== "string" || String(f.path).trim() === "") {
      warn(`跳过非法 folder 条目（缺少 path）: ${JSON.stringify(f)}`);
      continue;
    }
    const abs = path.resolve(workspaceFileDir, String(f.path).trim());
    const hasName = typeof f.name === "string" && f.name.trim() !== "";
    const rawName = hasName ? f.name : path.basename(abs);
    const name = sanitizeAgentName(rawName);
    if (!hasName) {
      log(`  folder 未指定 name，按 VS Code 规则取路径 basename: "${rawName}"（规范化为 "${name}"）`);
    }
    if (seenNames.has(name)) {
      warn(`folder name 重复 "${rawName}"（规范化为 "${name}"），已跳过重复项。`);
      continue;
    }
    seenNames.add(name);
    const rel = normalizeFolderPath(f.path, workspaceFileDir, workspaceRoot);
    const exists = fs.existsSync(abs);
    models.push({
      originalName: rawName,
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

/** YAML 单行标量转义：含空格或特殊字符时用双引号包裹（零依赖手写）。 */
function yamlScalar(s) {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** 由 permission 对象生成 agent markdown 的 frontmatter。 */
function agentFrontmatter(description, permission) {
  const lines = ["---"];
  lines.push(`description: ${yamlScalar(description)}`);
  lines.push(`mode: subagent`);
  lines.push(`permission:`);
  for (const [tool, rule] of Object.entries(permission)) {
    if (typeof rule === "string") {
      lines.push(`  ${tool}: ${rule}`);
    } else {
      lines.push(`  ${tool}:`);
      for (const [pattern, action] of Object.entries(rule)) {
        lines.push(`    ${yamlScalar(pattern)}: ${action}`);
      }
    }
  }
  lines.push(`---`);
  return lines.join("\n");
}

/**
 * 把绝对路径转成"路径段锚定"通配符：/a/b/fc-barcelona → 以双层星号开头、
 * 以目录 basename 为路径段、再以双层星号结尾的 pattern。
 *
 * 为什么不用相对路径（如 ../fc-barcelona 那种）：opencode 的权限 pattern 会随
 * 会话解析出的项目根变化；当项目根被解析成 / 时，相对 pattern 全部匹配不上，
 * 最终落到兜底 deny，所有编辑被拒。路径段锚定 pattern 无论根是 workspace-root
 * 还是 / 都命中。
 */
function segmentScope(absPath) {
  return `**/${path.basename(absPath)}/**`;
}

function writerMarkdown(folder) {
  // relPath 为 "." 的 folder 不应生成 writer（那是 workspace-root 本身）
  const scope = segmentScope(folder.absPath);
  const agentsRef = `${folder.relPath}/AGENTS.md`;
  const front = agentFrontmatter(
    `负责修改 ${folder.originalName} 仓库代码与契约实现的 Sub-Agent`,
    {
      // 铁律（opencode 语义：最后匹配获胜）：兜底 `**` deny 必须排在最前，
      // 具体 allow 排在其后才生效；写反 = allow 被兜底 deny 吞掉。
      edit: { "**": "deny", [scope]: "allow" },
      external_directory: { "**/openspec/**": "allow", [scope]: "allow" },
    }
  );
  const body = [
    `# ${folder.originalName} Writer`,
    ``,
    `你是 \`${folder.originalName}\` 仓库的专属 Writer Sub-Agent，由 Orchestrator 通过 Task 工具唤起（@${folder.name}-writer）。`,
    ``,
    `## 作用域（硬性）`,
    ``,
    `- 只写 \`${scope}\` 下的文件；\`openspec/\` 与其他仓库一律只读，绝不写入。`,
    ``,
    `## 工作协议`,
    ``,
    `1. 只执行 Task 指定的 \`openspec/changes/{change-name}/tasks.md\` 中的 Task；动工前必读该 Task 的上下文文件链接组：\`context.md\`（全局背景）、\`design.md\`（跨仓技术方案）、\`specs/${folder.name}/spec.md\`（你的专属 delta spec，主文件，capability 路径即本仓名）。`,
    `2. 动工前阅读 \`${agentsRef}\`（本仓协作约束：技术栈、目录约定、lint / typecheck / test 命令），与专属契约冲突时以本仓 \`AGENTS.md\` 为准并上报。`,
    `3. 完成后运行本仓约定的验证命令，向 Orchestrator 回报：修改的文件列表、验证结果、未解决的风险。`,
    ``,
    `## 禁止`,
    ``,
    `- 不修改本仓之外的任何文件；不写 \`openspec/\` 下的任何文件（含 \`review-report.md\`，那是 Reviewer 的）。`,
    ``,
    `<!-- 本文件由 scripts/init.mjs 自动生成。仓库增删改请更新 .code-workspace 后重新运行 npm run init，不要手动改路径。 -->`,
    ``,
  ].join("\n");
  return `${front}\n${body}`;
}

// 注意：本函数生成的 reviewer.md 必须与仓库模板 opencode/agents/reviewer.md 保持一致
// （upgrade 分发模板、init 重写同一文件，只改一侧会导致规则被静默回滚）。
function reviewerMarkdown() {
  const front = agentFrontmatter(`负责跨仓一致性审查的 Reviewer Agent`, {
    // 兜底 deny 在前、唯一 allow 在后（最后匹配获胜）
    edit: { "**": "deny", "**/openspec/changes/*/review-report.md": "allow" },
    external_directory: { "**": "allow" },
  });
  const body = [
    `# Reviewer`,
    ``,
    `你是跨仓一致性审查员，由 Orchestrator 通过 Task 工具唤起（@reviewer）。`,
    ``,
    `## 作用域（硬性）`,
    ``,
    `- 可读：所有仓库代码、\`AGENTS.md\`、\`openspec/\` 下的全部 Change 文档。`,
    `- 唯一可写：各 Change 下的 \`review-report.md\`。其他任何文件一律只读，绝不写业务代码。`,
    ``,
    `## 工作协议`,
    ``,
    `1. Orchestrator 会在 Prompt 中给出 Change 名。以 \`specs/{repo}/spec.md\`（各仓 delta spec）为**审查基准（唯一规范来源）**，\`design.md\` 仅作非规范性背景参考；结合各仓实际改动核对。`,
    `2. 逐项核对检查清单：接口定义一致性（前端调用的 API 与后端实现契约是否匹配）、数据模型与类型定义一致性、架构约束遵循情况。默认**不重跑** Writer 已执行并回报的验证命令——审查以 delta spec 与实现的一致性核对为主，仅在存疑时抽跑个别用例。审查**只核对契约面**（字段形状、缺省语义、判定顺序、门控一致性、调用方 / 实现方匹配、他仓规范遵循）；不涉及契约的实现细节记入报告建议项，不作为 \`FAILED\` 依据。`,
    `3. 把结果写入 \`openspec/changes/{change-name}/review-report.md\`：`,
    `   - \`Status\` 只能是 \`PENDING | PASSED | FAILED\` 之一；`,
    `   - \`FAILED\` 时逐条列出 \`Target\`（如 \`frontend-writer\`）、\`Issue\`、\`Action Required\`，并在"结论与下一动作"中给出 Remediation Task 的 assignee 建议；`,
    `   - \`PASSED\` 时写明"各仓一致，可以合并"。`,
    ``,
    `## 禁止`,
    ``,
    `- 不代写 \`review-report.md\` 之外的任何文件，不直接修复业务代码（修复是 Writer 的 Remediation Task）。`,
    `- 不得在存在不一致时给出 \`PASSED\`。`,
    ``,
    `<!-- 本文件由 scripts/init.mjs 自动生成，重新运行 npm run init 可重新生成。 -->`,
    ``,
  ].join("\n");
  return `${front}\n${body}`;
}

function orchestratorConfig(writerNames) {
  const task = {};
  for (const n of writerNames) {
    task[`${n}-writer`] = "allow";
  }
  task["reviewer"] = "allow";
  return {
    $schema: "https://opencode.ai/config.json",
    // 新会话默认进入 orchestrator agent；全局权限同时约束其他 agent。
    default_agent: "orchestrator",
    permission: {
      // 兜底 deny 在前，具体 allow 在后（opencode: 最后匹配获胜）；
      // 统一用 `**/` 路径段锚定，避免项目根解析异常时相对 pattern 失效。
      edit: {
        "**": "deny",
        "**/openspec/**": "allow",
        "**/openspec/changes/*/review-report.md": "deny",
      },
      external_directory: {
        "**": "allow",
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

  log("==> 3/6 路径规范化");
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

  log("==> 4/6 生成 Sub-Agent 配置");
  // opencode 只识别 .opencode/agents/ 下的 markdown agent 文件，
  // 生成格式为 frontmatter（description / mode / permission）+ Markdown 正文指令。
  const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
  const writerNames = [];
  for (const w of writers) {
    const fileName = `${w.name}-writer.md`;
    const filePath = path.join(agentsDir, fileName);
    const content = writerMarkdown(w);
    if (args.dryRun) {
      log(`  [dry-run] 将写入: ${filePath}`);
      log(content);
    } else {
      await writeFileSafe(filePath, content, args);
    }
    writerNames.push(w.name);
  }

  const reviewerPath = path.join(agentsDir, "reviewer.md");
  const reviewerContent = reviewerMarkdown();
  if (args.dryRun) {
    log(`  [dry-run] 将写入: ${reviewerPath}`);
    log(reviewerContent);
  } else {
    await writeFileSafe(reviewerPath, reviewerContent, args);
  }

  log("==> 5/6 生成/更新 Orchestrator opencode.jsonc");
  const orch = orchestratorConfig(writerNames);
  const orchPath = path.join(workspaceRoot, "opencode.jsonc");
  const orchContent = toJsoncWithHeader(
    orch,
    [
      'Root Orchestrator Agent (Primary) —— 跨仓架构编排器',
      `由 scripts/init.mjs 自动生成。writers: [${writerNames.join(", ") || "(none)"}]`,
      `workspace: ${path.basename(workspaceFile)}`,
      '权限语义（opencode: 最后匹配获胜）：兜底 deny 在前、具体 allow 在后；',
      'pattern 用路径段锚定（前缀带双层星号），项目根解析异常时仍能命中。',
    ]
  );
  if (args.dryRun) {
    log(`  [dry-run] 将写入: ${orchPath}`);
    log(orchContent);
  } else {
    await writeFileSafe(orchPath, orchContent, args);
  }

  log("==> 6/6 同步 OpenSpec 项目配置");
  // 同步策略（双入口覆盖，用户无需记得单独跑 sync:config）：
  //   - `npm run init` 时，由 package.json 的 postinit 钩子自动执行 sync:config；
  //   - 直接 `node scripts/init.mjs`（含 create.mjs --init）时，在此处兜底执行。
  const viaNpmInit = process.env.npm_lifecycle_event === "init";
  if (args.skipOpenspec) {
    log("  已跳过（--skip-openspec）。需要时手动运行 npm run sync:config。");
  } else if (args.dryRun) {
    log("  [dry-run] 将执行 sync:config（注：npm run init 时 postinit 钩子仍会真实执行；纯预览请用 node scripts/init.mjs --dry-run）");
  } else if (viaNpmInit) {
    log("  由 postinit 钩子处理：npm run init 会自动执行 sync:config。");
  } else {
    try {
      const result = syncConfig({ root: workspaceRoot });
      for (const line of result.messages) log(`  ${line}`);
    } catch (err) {
      warn(`OpenSpec 配置同步失败: ${err.message}`);
      warn("请手动运行 npm run sync:config；如需官方 /opsx-* 命令，装好 CLI 后运行 openspec init --tools opencode --force。");
    }
  }

  log("");
  log("完成。下一步:");
  log("  1. 检查 .opencode/agents/ 下生成的 *-writer.md 作用域是否正确");
  log("  2. 在 workspace-root 运行 /prepare 确认各仓就位");
  log("  3. 装好官方 CLI 后运行 openspec init --tools opencode --force（生成 /opsx-* 命令）");
  log("  4. 新建 Spec Change：用 /opsx-propose 起草，扩展文件见 openspec/templates/");
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
