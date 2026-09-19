# opencode-workspace-starter

基于 **OpenCode Sub-Agent 体系 + OpenSpec SDD**（Spec-Driven Development，规约驱动开发）的多仓库协作开发框架脚手架。

## 架构一览

```text
workspace-root/              # Orchestrator 运行位置（本仓库）
├── AGENTS.md                # Orchestrator 编排指令（Primary Agent）
├── opencode.jsonc           # 主配置：openspec 可写、业务仓只读、task 授权
├── agents/
│   ├── {repo}-writer.jsonc  # 每个仓库一个 Writer（mode: subagent，锁定单仓）
│   └── reviewer.jsonc       # 跨仓审查员（mode: subagent，只写 review-report.md）
├── commands/prepare.md      # /prepare 命令：生成 openspec/repo-context.md
├── bin/create.mjs           # scaffolding 入口：npx github:user/repo 即用
├── scripts/init.mjs         # init 脚本：从 .code-workspace 派生全部 Agent 配置
└── openspec/
    ├── AGENTS.md            # OpenSpec SDD 协作规范
    └── changes/{name}/      # 每个需求一个 Change（proposal/context/design/tasks/specs/review-report）
```

### 核心设计原则

1. **`.code-workspace` 是唯一目录配置源** — 所有 Agent 路径由 `npm run init` 自动派生，不手动维护。
2. **Root Orchestrator（Primary）** — 拥有全局读权限与 `task` 调度权限，**不写任何业务代码**，只负责创建 Spec Change、拆分 task、调度子 Agent。
3. **Per-Repo Writer（`mode: "subagent"`）** — 每仓一个，只写自己的仓库（权限物理隔离），通过 Task 接收文件链接组并执行。
4. **Reviewer（`mode: "subagent"`）** — 只读所有仓，只写 `openspec/changes/*/review-report.md`，负责跨仓一致性审查。
5. **OpenSpec SDD** — 每个 Change 包含 `proposal.md / context.md / design.md / tasks.md / review-report.md / specs/{repo}.md`。

## 快速开始

> **npx 可以直接指定 GitHub 仓库，无需发布到 npm。** 把本仓库推到 GitHub 后即可使用（将 `YOUR_USER` 换成你的用户名）。

```bash
# 方式 A：从 GitHub 一键 scaffolding（推荐）
npx github:YOUR_USER/opencode-workspace-starter my-project
cd my-project
# 编辑 my-project.code-workspace 的 folders（相对该文件位置的路径，已自动由模板生成）

# 方式 B：本地已有本仓库时直接运行
node bin/create.mjs my-project --init

# 生成 Agent 配置
npm run init -- --yes

# 启动 OpenCode（workspace-root），生成上下文索引
opencode run /prepare

# 新建一个 Change
cp -r openspec/changes/template openspec/changes/my-first-change
# 按顺序编写 proposal.md → context.md → design.md → specs/{repo}.md → tasks.md
```

可用变体：

```bash
npx -y github:YOUR_USER/opencode-workspace-starter my-project --init  # 跳过安装确认并自动跑 init
npx github:YOUR_USER/opencode-workspace-starter#v0.2.0 my-project      # 指定分支 / tag / commit
node bin/create.mjs my-project --force                                # 目标目录非空时覆盖
```

原理：`npx <user>/<repo>` 会从 GitHub 拉取仓库打包，运行 `package.json` 的 `bin`（`create-opencode-workspace`，即 `bin/create.mjs`），把整套模板拷贝到目标目录。私有仓库需要本机有 git/ssh 凭证。

## Orchestrator 如何通过 Task 工具自动调度 Writer / Reviewer

这是本框架与传统“人工切换 Agent”模式的本质区别：**Orchestrator 在生成 `tasks.md` 后立即使用 OpenCode Task 工具唤起子 Agent，无需用户手动介入。**

```text
Orchestrator（Primary）
  │  Task 工具并发派发
  ├─→ @frontend-writer  "请读取并执行 openspec/changes/X/tasks.md 中的 Task 2（含 context/design/specs 上下文），完成后回报验证结果"
  ├─→ @backend-writer   "请读取并执行 openspec/changes/X/tasks.md 中的 Task 1（含 context/design/specs 上下文），完成后回报验证结果"
  │  （Writer 各自回报：修改文件列表、验证结果、风险）
  │  Task 工具唤起审查
  └─→ @reviewer         "tasks.md 已完成，请审查并写入 review-report.md"
        │  PASSED → Change 完成，总结汇报
        │  FAILED → Orchestrator 生成 Remediation Task → 重新派发 Writer → 再次 Review
```

- 传递给 Writer 的 Prompt 必须包含三件套：`context.md`（全局背景）+ `design.md`（跨仓方案）+ `specs/{target}.md`（专属契约，主文件）。
- `tasks.md` 中每个 Task 有唯一 `Assignee`（如 `frontend-writer`）与 `Status`（`pending → in_progress → done/failed`）；Orchestrator 派发前置 `in_progress`，收到回报后更新。
- Review `FAILED` 时，Orchestrator 解析 `review-report.md` 问题列表的 `Target / Issue / Action Required`，追加编号递增的 Remediation Task 并重新派发，直到 `PASSED`（同一问题连续失败 3 次后停下并请求人工决策）。
- 详细规则见 `AGENTS.md` 第 4–5 节。

## /prepare 与上下文索引

`/prepare`（定义见 `commands/prepare.md`）只读业务仓、只写 `openspec/repo-context.md`：

- 读取各仓 `AGENTS.md`，提取技术栈、目录约定、lint / typecheck / test 命令。
- 记录各仓 `git rev-parse HEAD` commit hash 与工作区洁净度。
- Orchestrator 在新建 Change 时引用该索引填充 `context.md` 的“受影响仓库清单”，并在 commit 漂移时发出提示。

维护节奏：每次新建 Change 前运行一次；大仓重构后重新运行。

## 权限速查

| Agent | `mode` | 可写 | 只读 | 可唤起 |
|-------|--------|------|------|--------|
| Orchestrator | primary | `openspec/**`（除 review-report） | 所有仓 | `*-writer`、`reviewer` |
| `{repo}-writer` | subagent | 本仓 `{path}/**` | `openspec/**` | — |
| reviewer | subagent | `openspec/changes/*/review-report.md` | 所有仓 | — |

## 目录结构

```text
opencode-workspace-starter/
├─ README.md
├─ package.json                      # 含 bin（create-opencode-workspace），支持 npx github:user/repo
├─ template.code-workspace
├─ opencode.jsonc
├─ AGENTS.md
├─ bin/
│  └─ create.mjs                     # scaffolding 入口（npx / node 两用）
├─ commands/
│  └─ prepare.md
├─ scripts/
│  └─ init.mjs
├─ agents/
│  ├─ README.md
│  └─ reviewer.jsonc
├─ openspec/
│  ├─ AGENTS.md
│  ├─ specs/
│  │  └─ .gitkeep
│  └─ changes/
│     ├─ .gitkeep
│     └─ template/
│        ├─ proposal.md
│        ├─ context.md
│        ├─ design.md
│        ├─ tasks.md
│        ├─ review-report.md
│        └─ specs/
│           └─ .gitkeep
└─ .gitignore
```
