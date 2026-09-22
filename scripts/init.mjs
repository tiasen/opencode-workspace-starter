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
import {
  findWorkspaceFile,
  loadWorkspace,
  buildFolderModels,
  isAbsoluteFolderPath,
} from "./workspace-lib.mjs";

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

// toPosix / stripJsonComments / findWorkspaceFile / loadWorkspace /
// normalizeFolderPath / sanitizeAgentName / buildFolderModels 已抽取到
// scripts/workspace-lib.mjs，由 init.mjs 与 worktree.mjs 共用，避免解析规则漂移。

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

/**
 * 确保 workspace-root 是一个独立 git 仓库 —— 这是 worktree（并行检出）能力的硬前置。
 *
 * 幂等：已在独立仓库内则跳过；位于更大的仓库内部时告警（worktree 需要 workspace-root
 * 作为独立仓库，否则会连带检出外层仓库）。
 *
 * 这里只 `git init`，**不创建 commit**：worktree 的起点必须是一个 commit，但首个基线
 * commit 由 `worktree.mjs new` 在"workspace 定义已定稿"时自动补齐，避免把尚是占位路径的
 * .code-workspace 固化进历史。
 */
function ensureGitRepo(dir, opts) {
  let top = null;
  try {
    top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    top = null;
  }

  if (top === null) {
    if (opts.dryRun) {
      log("  [dry-run] 将执行: git init -b main（worktree 能力的前置）");
      return;
    }
    try {
      execSync("git init -b main", { cwd: dir, stdio: "ignore" });
      log("  ✓ 已初始化 git 仓库（main）；首个基线 commit 将在 worktree.mjs new 时自动创建。");
    } catch (err) {
      warn(`git init 失败: ${String(err.message).split("\n")[0]}`);
    }
    return;
  }

  let same = false;
  try {
    same = fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    same = path.resolve(top) === path.resolve(dir);
  }
  if (same) {
    log(`  ✓ git 仓库已就绪（${top}）`);
  } else {
    warn(
      `workspace-root 位于另一个 git 仓库内部（${top}）：worktree 需要 workspace-root 作为独立仓库，` +
        `否则会连带检出外层仓库。建议把 workspace-root 独立成仓。`
    );
  }
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
// 2/3. 解析 .code-workspace 与路径规范化
// 实现见 scripts/workspace-lib.mjs（init / worktree 共用，规则唯一）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 权限 pattern 生成（改之前务必读懂，这里有两个反直觉的 opencode 语义）
// ---------------------------------------------------------------------------
//
// 1) `edit` 权限的匹配对象是 **worktree 相对路径**
//    （opencode 源码：write / edit 工具提交 `path.relative(Instance.worktree, filepath)`）。
//      - workspace-root 是 git 仓时 → 仓内文件提交为 `openspec/changes/x/tasks.md`（无前导 /）；
//      - workspace-root 不是 git 仓时（Instance.worktree === "/"）→ 提交为
//        `Users/x/proj/openspec/changes/x/tasks.md`（绝对路径去掉前导 /）。
//
// 2) 通配符是**简单匹配**，不是 glob：`*` 被替换成 `.*`，可匹配任意字符**包括 `/`**；
//    `**` 不是 globstar，等价于 `*`。于是 `**/openspec/**` 的正则是 `.*\/openspec\/.*`，
//    **要求 `openspec` 前面必须有一个 `/`** —— 它匹配不了 `openspec/changes/x/tasks.md`。
//
// 结论：锚定"仓内路径"（如 openspec）时，必须**同时**给出两种形式：
//   - 相对形式   `openspec/**`      ← git 仓（worktree 相对）
//   - 段锚定形式 `**/openspec/**`   ← 非 git 仓 / 其他根（绝对路径去前导 /）
// 只写一种，必然在其中一种环境下静默失效；而 subagent 里未决的 `ask` 会退化为 `deny`，
// 没有交互可救，表现为"Writer 只能靠 bash 写文件"。
//
// 另外：规则顺序即优先级（opencode: 最后匹配获胜），兜底 deny 必须排在最前。

/** 相对 workspace-root 的 POSIX pattern（如 "../frontend" → "../frontend/**"）。 */
function relScope(relPath) {
  return `${relPath.split(path.sep).join("/")}/**`;
}

/** 路径段锚定 pattern（如 "**\/frontend/**"），覆盖非 git 项目与 worktree 场景。 */
function segmentScope(absPath) {
  return `**/${path.basename(absPath)}/**`;
}

function writerMarkdown(folder) {
  // relPath 为 "." 的 folder 不应生成 writer（那是 workspace-root 本身）
  const rel = relScope(folder.relPath);
  const scope = segmentScope(folder.absPath);
  const agentsRef = `${folder.relPath}/AGENTS.md`;
  const front = agentFrontmatter(
    `负责修改 ${folder.originalName} 仓库代码与契约实现的 Sub-Agent`,
    {
      // 相对形式在前、段锚定在后，两者都 allow；兜底 `**` deny 必须排在最前。
      // 相对形式覆盖"子应用在 workspace-root 内部"（此时路径不含 /<name>/ 前缀），
      // 段锚定形式覆盖 worktree（../<name>/...）与非 git 项目（绝对路径去前导 /）。
      edit: { "**": "deny", [rel]: "allow", [scope]: "allow" },
      // external_directory 的匹配对象是**绝对路径**，故只保留段锚定形式
      // （相对形式对绝对路径永远匹配不上；段锚定同时对 worktree 的成员路径安全）。
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
    `- 只写 \`${folder.relPath}\`（${folder.originalName} 仓）下的文件；\`openspec/\` 与其他仓库一律只读，绝不写入。`,
    ``,
    `## 工作协议`,
    ``,
    `1. 只执行 Task 指定的 \`openspec/changes/{change-name}/tasks.md\` 中的 Task；动工前必读该 Task 的上下文文件链接组：\`context.md\`（全局背景）、\`design.md\`（跨仓技术方案）、\`specs/${folder.name}/spec.md\`（你的专属 delta spec，主文件，capability 路径即本仓名）。`,
    `2. 动工前阅读 \`${agentsRef}\`（本仓协作约束：技术栈、目录约定、lint / typecheck / test 命令），与专属契约冲突时以本仓 \`AGENTS.md\` 为准并上报。`,
    `3. 若 Task 指定了本仓技能（见下"技能引用"），先完整阅读其 SKILL.md 并严格按其约定执行；技能若带配套脚本，以本仓为 cwd 调用。`,
    `4. 完成后运行本仓约定的验证命令，向 Orchestrator 回报：修改的文件列表、验证结果、未解决的风险。`,
    ``,
    `## 技能引用（只引用、不复制）`,
    ``,
    `- 本仓技能归本仓所有，位置在本仓自己的技能目录（如 \`${folder.relPath}/.opencode/skills/<name>/SKILL.md\`，也可能是 \`.claude/skills/\` 或 \`.agents/skills/\`），服务本仓自己的开发者；框架**不复制、不集中**它们。`,
    `- 你通过 \`read\` 直接读取 SKILL.md（只是文件，不走 \`skill\` 工具——后者只认 workspace-root 实例内注册的技能）。`,
    `- 需要用哪个技能、确切路径是什么，以 Task Prompt 为准；不确定的回问 Orchestrator，不要猜。`,
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
    // 兜底 deny 在前，两种形式都 allow（最后匹配获胜）。见文件上方权限说明。
    edit: {
      "**": "deny",
      "openspec/changes/*/review-report.md": "allow",
      "**/openspec/changes/*/review-report.md": "allow",
    },
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
      // 兜底 deny 在前，具体 allow 在后（opencode: 最后匹配获胜）。
      // edit 的匹配对象是 worktree 相对路径，故 openspec 必须同时给两种形式：
      //   openspec/**      ← workspace-root 是 git 仓（仓内相对路径）
      //   **/openspec/**   ← 不是 git 仓（绝对路径去前导 /）
      // 详见本文件上方"权限 pattern 生成"的说明。
      edit: {
        "**": "deny",
        "openspec/**": "allow",
        "**/openspec/**": "allow",
        "openspec/changes/*/review-report.md": "deny",
        "**/openspec/changes/*/review-report.md": "deny",
      },
      external_directory: {
        "**": "allow",
      },
      task,
      bash: {
        "opencode *": "allow",
        // 注意 `*` 要求后面有空格，故无参的 `git status` 需单独一条。
        // `git status` 是只读命令，放项目级；`git -C *` 只放在 orchestrator 的 agent 文件里，
        // 不放项目级（否则所有 agent 都能跑任意 git 命令）。
        "git status": "allow",
        "git status *": "allow",
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

  const workspaceFile = findWorkspaceFile({ root: STARTER_ROOT, explicit: args.workspace });
  if (!workspaceFile) {
    fail("未找到 .code-workspace 文件。请使用 --workspace 指定，或从 template.code-workspace 复制一份。");
    process.exit(1);
  }
  log("==> 2/6 解析 workspace");
  log(`  workspace 文件: ${workspaceFile}`);
  let ws;
  try {
    ws = loadWorkspace(workspaceFile);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
  const workspaceFileDir = ws.dir;

  log("==> 3/6 路径规范化");
  const folders = buildFolderModels(ws.folders, workspaceFileDir, workspaceRoot, { log, warn });
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
    if (f.isAbsolute) {
      warn(
        `folder "${f.originalName}" 使用了绝对路径，worktree 的镜像布局要求相对路径（否则无法为每个 worktree 正确解析成员）。`
      );
    }
  }

  if (!folders.some((f) => f.isRoot)) {
    warn(
      '.code-workspace 未声明 workspace-root（{ "name": "workspace-root", "path": "." }）：' +
        "Agent 相对路径仍以本仓为基准、worktree 也会恒定创建它，但建议补上以便 VS Code 侧看到本仓。"
    );
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
      'edit 的匹配对象是 worktree 相对路径，且通配符是简单匹配（* 可含 /，** 非 globstar），',
      '故锚定仓内路径时同时给出相对形式（openspec/**）与段锚定形式（**/openspec/**）。',
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

  log("==> git 仓库检查（worktree 前置）");
  ensureGitRepo(workspaceRoot, args);

  log("");
  log("完成。下一步:");
  log("  1. 检查 .opencode/agents/ 下生成的 *-writer.md 作用域是否正确");
  log("  2. 在 workspace-root 运行 /prepare 确认各仓就位");
  log("  3. 装好官方 CLI 后运行 openspec init --tools opencode --force（生成 /opsx-* 命令）");
  log("  4. 新建 Spec Change：用 /opsx-propose 起草，扩展文件见 openspec/templates/");
  log("  5. 需要并行开发时：node scripts/worktree.mjs new <id>（自动补齐基线 commit 并创建整套检出）");
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
