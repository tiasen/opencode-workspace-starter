# opencode-workspace-starter

基于 **OpenCode Sub-Agent 体系 + OpenSpec SDD**（Spec-Driven Development，规约驱动开发）的多仓库协作开发框架脚手架。

## 架构一览

```text
workspace-root/              # Orchestrator 运行位置（本仓库）
├── AGENTS.md                # Orchestrator 编排指令（Primary Agent）
├── opencode.jsonc           # 主配置：openspec 可写、业务仓只读、task 授权
├── .opencode/
│   ├── agents/
│   │   ├── orchestrator.md          # Orchestrator 主 agent（mode: primary，默认进入）
│   │   ├── {repo}-writer.md         # 每个仓库一个 Writer（由 npm run init 生成）
│   │   └── reviewer.md              # 跨仓审查员（mode: subagent）
│   ├── commands/
│   │   ├── prepare.md               # /prepare：workspace 就位检查（无状态）
│   │   └── opsx-*.md                # 官方 OpenSpec 命令（openspec init 生成）
│   └── skills/                      # 官方 OpenSpec skills（openspec init 生成）
├── bin/create.mjs           # scaffolding 入口：npx github:user/repo 即用
├── scripts/init.mjs         # init 脚本：从 .code-workspace 派生全部 Agent 配置
└── openspec/
    ├── FRAMEWORK.md               # 框架编排层规范
    ├── config.yaml                # OpenSpec 生效配置（npm run sync:config 同步）
    ├── config.template.yaml       # 配置模板（rules 让官方命令按仓生成 spec）
    ├── specs/                     # 基线 spec（openspec archive 维护）
    ├── templates/                 # 框架扩展模板（context / review-report / tasks 派发示例）
    └── changes/
        ├── {name}/                # 每个需求一个 Change
        └── archive/               # 已归档 Change（openspec archive 生成）
```

> **视角说明**：上面的树是用户 scaffold 后的 workspace-root。**本仓库是源码**：面向用户的模板
> 目录是 `opencode/`（无点），scaffold / upgrade 时映射为 `.opencode/`；源码自己的 `.opencode/`
> 只是本机开发运行时目录，不提交、也不复制给用户。映射清单见 `scripts/template-map.mjs`。
>
> 约束：opencode 只识别 `.opencode/agents/*.md` 与 `.opencode/commands/*.md`（Markdown + frontmatter）。
> 不要在 `.opencode/agents/` 下放 `README.md` 之类的说明文件——每个 `.md` 都会被注册成一个 agent。
> 不要手动编辑 `.opencode/agents/` 下的路径；仓库增删改请更新 `.code-workspace` 后重新运行 `npm run init`，
> `opencode.jsonc` 中的 `permission.task` 会同步追加授权。

### 核心设计原则

1. **`.code-workspace` 是唯一目录配置源** — 所有 Agent 路径由 `npm run init` 自动派生，不手动维护。
2. **Root Orchestrator（Primary）** — 拥有全局读权限与 `task` 调度权限，**不写任何业务代码**，只负责创建 Spec Change、拆分 task、调度子 Agent。
3. **Per-Repo Writer（`mode: "subagent"`）** — 每仓一个，只写自己的仓库（权限物理隔离），通过 Task 接收文件链接组并执行。
4. **Reviewer（`mode: "subagent"`）** — 只读所有仓，只写 `openspec/changes/*/review-report.md`，负责跨仓一致性审查。
5. **OpenSpec SDD** — 每个 Change 包含官方四件套（`proposal.md` / `specs/{repo}/spec.md` / `design.md` / `tasks.md`）+ 本框架扩展（`context.md` / `review-report.md`）。

## 快速开始

> **npx 可以直接指定 GitHub 仓库，无需发布到 npm。** 将 `YOUR_USER` 换成你的用户名（本仓库为 `tiasen`）。

### 0. 前置：安装 OpenSpec CLI

`/opsx-*` 命令由官方 CLI 生成，先装一次（不装也能用本框架的编排部分，只是没有官方起草命令）：

```bash
npm install -g @fission-ai/openspec
openspec --version
```

### 1. 生成 workspace

```bash
# 方式 A：从 GitHub 一键 scaffolding
npx github:YOUR_USER/opencode-workspace-starter my-project
cd my-project
# → 自动生成 my-project.code-workspace，编辑其中的 folders 指向真实仓库

# 方式 A2：已有 .code-workspace（workspace 文件先行）
mkdir my-project && cd my-project
# 先把你的 my-project.code-workspace 放入当前目录（会被保留，绝不覆盖）
npx github:YOUR_USER/opencode-workspace-starter . --init

# 方式 B：本地已有本仓库
node bin/create.mjs my-project --init
```

### 2. 初始化 OpenSpec（在 workspace-root 执行一次）

```bash
openspec init --tools opencode --force
# 生成 .opencode/commands/opsx-*.md 与 .opencode/skills/*；
# 已存在的 openspec/config.yaml 会被保留，不会覆盖。
```

### 3. 生成 Agent 与项目配置

```bash
npm run init -- --yes   # 派生 .opencode/agents/*.md、opencode.jsonc，并同步 openspec/config.yaml
npm run sync:config     # 幂等；只把 config.template.yaml 的 schema/rules/operations 三段同步过去
```

> 若第 1 步用了 `--init`，`npm run init` 已自动跑过一次；此处重跑幂等，无副作用。

### 4. 开始一个 Change（在 opencode TUI 内输入斜杠命令）

```bash
opencode                # 启动 TUI；新会话默认进入 orchestrator agent
```

```text
/prepare                          # 确认各仓就位（路径可解析、AGENTS.md 齐全）
/opsx-propose my-first-change     # 官方命令起草 proposal + specs/<repo>/spec.md + design + tasks
```

> `/opsx-propose` 等命令在 opencode 里是连字符形式（Claude Code 里才是 `/opsx:propose`），
> 且需先完成第 2 步。阶段严格跟随官方命令，**主 agent 不会自动推进**：
> `/opsx-explore`（只讨论，不生成 spec）→ `/opsx-propose`（起草 artifacts 后**停下等你 review**）
> → `/opsx-apply`（此时才用 Task 工具派发给各仓 Writer）→ `/opsx-archive`（显式归档）。

### 5. 保持更新（已安装用户，无需再 npx）

```bash
npm run check:update   # 对比本地与远端最新 tag
npm run upgrade        # 覆盖框架文件到最新版
```

详见下方「版本与升级」。

可用变体：

```bash
npx -y github:YOUR_USER/opencode-workspace-starter my-project --init  # 跳过安装确认并自动跑 init
npx github:YOUR_USER/opencode-workspace-starter#v0.2.0 my-project      # 指定分支 / tag / commit
node bin/create.mjs my-project --force                                # 目录含非 workspace 文件时覆盖（同名文件会被替换）
```

原理：`npx <user>/<repo>` 会从 GitHub 拉取仓库打包，运行 `package.json` 的 `bin`（`create-opencode-workspace`，即 `bin/create.mjs`），把整套模板拷贝到目标目录。私有仓库需要本机有 git/ssh 凭证。

## Apply 阶段：Orchestrator 如何调度 Writer / Reviewer

阶段严格跟随官方命令，由用户显式驱动：`/opsx-explore`（只讨论）→ `/opsx-propose`（起草后停下等 review）→ `/opsx-apply`（才派发）→ `/opsx-archive`（显式归档）。**主 agent 不会在你确认方案前自动起草或派发。**

一旦进入 Apply 阶段，Orchestrator 使用 OpenCode Task 工具唤起子 Agent，无需你手动切换 agent：

```text
Orchestrator（Primary）
  │  Task 工具并发派发
  ├─→ @frontend-writer  "请读取并执行 openspec/changes/X/tasks.md 中的 Task 2（含 context/design/specs 上下文），完成后回报验证结果"
  ├─→ @backend-writer   "请读取并执行 openspec/changes/X/tasks.md 中的 Task 1（含 context/design/specs 上下文），完成后回报验证结果"
  │  （Writer 各自回报：修改文件列表、验证结果、风险）
  │  （按 Review 判定）需要审查时唤起 reviewer，范围限涉及仓
  └─→ @reviewer         "已完成，审查范围：frontend、design-docs；写入 review-report.md"
        │  PASSED → Change 完成，总结汇报
        │  FAILED → Orchestrator 生成 Remediation Task → 重新派发 Writer → 再次 Review
```

- 传递给 Writer 的 Prompt 必须包含三件套：`context.md`（全局背景）+ `design.md`（跨仓方案）+ `specs/{target}/spec.md`（专属 delta spec，主文件）。
- `tasks.md` 中每个 Task 有唯一 `Assignee`（如 `frontend-writer`）与 `Status`（`pending → in_progress → done/failed`）；Orchestrator 派发前置 `in_progress`，收到回报后更新。
- **审查按 `context.md` 的 Review 判定执行，不是每次必跑**：跨仓契约变更、多仓联动、或需符合他仓规范时才调用 `@reviewer`，且范围只限涉及仓；纯 UI / 脚本 / 临时修复等单仓内部改动可跳过并记录理由。用户可强制全量一致性检查。
- Review `FAILED` 时，Orchestrator 解析 `review-report.md` 问题列表的 `Target / Issue / Action Required`，追加编号递增的 Remediation Task 并重新派发，直到 `PASSED`（同一问题连续失败 3 次后停下并请求人工决策）。
- 详细规则见 `AGENTS.md` 第 4–5 节。

## /prepare 与各仓就位检查

`/prepare`（定义见 `.opencode/commands/prepare.md`）是无状态检查：只读业务仓、不写任何文件，结果对话内回报：

- 校验 `.code-workspace` 中各 folder 路径可解析、仓库存在、`AGENTS.md` 齐全。
- 记录各仓工作区洁净度（不记录、不比对 commit——执行依据永远是 live 代码）。
- 缺仓时如实回报，由 Orchestrator 决定补齐检出还是缩小 Change 范围。

维护节奏：每次新建 Change 前运行一次；大仓重构后重新运行。

## 权限速查

| Agent | `mode` | 可写 | 只读 | 可唤起 |
|-------|--------|------|------|--------|
| Orchestrator | primary | `**/openspec/**`（除 review-report） | 所有仓 | `*-writer`、`reviewer` |
| `{repo}-writer` | subagent | 本仓 `**/{repo}/**` | `**/openspec/**` | — |
| reviewer | subagent | `**/openspec/changes/*/review-report.md` | 所有仓 | — |

### Writer 文件示例（由 `init` 生成）

`{ "name": "frontend", "path": "../frontend" }` 生成 `.opencode/agents/frontend-writer.md`：

```md
---
description: "负责修改 frontend 仓库代码与契约实现的 Sub-Agent"
mode: subagent
permission:
  edit:
    "**": deny                  # 兜底 deny 必须在前（opencode: 最后匹配获胜）
    "**/frontend/**": allow      # 路径段锚定，项目根解析异常时仍命中
  external_directory:
    "**/openspec/**": allow
    "**/frontend/**": allow
---

# frontend Writer
（正文：作用域声明 + 工作协议——读 trio 上下文、遵守 `../frontend/AGENTS.md`、验证后回报）
```

新增仓库时往 `.code-workspace` 的 `folders` 追加一项，运行 `npm run init -- --yes` 即可生成新的 writer。

> **权限顺序陷阱**：opencode 的权限规则按"最后匹配获胜"求值。兜底 `**` deny 若排在
> 具体 allow 之后，会吞掉 allow，导致编辑全被拒（现象：agent 只能用 bash 写文件）。
> 生成的配置已按"兜底在前、具体在后"排列，并统一用 `**/` 路径段锚定——即使 opencode
> 把项目根解析成 `/`，权限依然命中。若你手改过这些文件，重新运行 `npm run init` 恢复。

## 版本与升级

框架版本记录在 workspace-root 的 `package.json.version`（由框架管理，请勿手改）。

```bash
npm run check:update            # 对比本地与远端最新 tag，看是否有新版本
npm run upgrade                 # 覆盖框架文件到最新版，不动你的文件
npm run upgrade -- --dry-run    # 先预览会覆盖哪些文件
```

升级只覆盖「框架拥有」的文件（`opencode/* → .opencode/*`、`scripts/*`、`AGENTS.md`、
`openspec/{FRAMEWORK.md, config.template.yaml, templates/*}`），并合并 `package.json` 的
框架 scripts 与 version；**绝不触碰**你的 `*.code-workspace`、`opencode.jsonc`、
`openspec/config.yaml`、`openspec/{specs,changes}/**`、`.opencode/agents/*-writer.md`、
`.opencode/commands/opsx-*.md`、`.opencode/skills/**`。升级后建议跑一次 `npm run init -- --yes`。

## 维护者指南（开发本框架）

- **模板 vs 开发目录**：用户模板在 `opencode/`（无点，提交）；仓库根的 `.opencode/` 是本机
  开发/运行时目录，已 gitignore，不要提交、也不要复制给用户。映射集中在 `scripts/template-map.mjs`。
- **版本纪律**：任何面向用户的改动都必须提升 `package.json.version`，否则 pre-push 拒绝：
  ```bash
  npm run hooks:install   # 一次性：git config core.hooksPath .githooks
  npm version patch       # 或 minor / major
  npm run check           # 手动自检（CI 亦会校验）
  ```
- **发布**：push 到 `main` 后，`.github/workflows/release.yml` 发现 `v<version>` 不存在时自动打
  tag + 创建 release；PR 由 `version-check.yml` 兜底校验版本是否提升。
- **本地验证**：`npm pack --dry-run` 查看打包内容；在 `/tmp` 里 `node bin/create.mjs <dir> --init`
  验证 scaffold 与 `opencode/ → .opencode/` 映射。

## 目录结构

```text
opencode-workspace-starter/            # 源码仓库（不是用户的 workspace-root）
├─ README.md
├─ package.json                      # bin + files + 版本脚本；version = 框架版本
├─ template.code-workspace
├─ template.gitignore                # scaffold 时写成用户的 .gitignore
├─ opencode.jsonc
├─ AGENTS.md
├─ opencode/                         # 用户模板（无点）；scaffold → 目标项目 .opencode/
│  ├─ agents/
│  │  ├─ orchestrator.md            # Orchestrator 主 agent（mode: primary）
│  │  └─ reviewer.md                # 跨仓审查员（{repo}-writer.md 由 init 按仓生成）
│  └─ commands/
│     └─ prepare.md                  # /prepare 命令（含 frontmatter description）
├─ bin/
│  └─ create.mjs                     # scaffolding 入口（npx / node 两用）
├─ scripts/
│  ├─ init.mjs                       # 派生 agents + opencode.jsonc，末尾自动 sync:config
│  ├─ sync-config.mjs                # 同步 openspec/config.yaml（npm run sync:config）
│  ├─ sync-config-lib.mjs            # 同步核心逻辑（供 init.mjs import）
│  ├─ template-map.mjs               # 源码模板 → 用户项目 的映射/清单（create、upgrade 共用）
│  ├─ check-version.mjs              # 提交前版本门禁（npm run check）
│  └─ upgrade.mjs                    # 升级命令（npm run upgrade / check:update）
├─ .githooks/
│  └─ pre-push                       # 版本门禁钩子（npm run hooks:install 启用）
├─ .github/workflows/
│  ├─ release.yml                    # 版本变化时自动 tag + release
│  └─ version-check.yml              # PR 版本校验
├─ openspec/
│  ├─ FRAMEWORK.md                   # 框架编排层规范（artifact 格式以官方 schema 为准）
│  ├─ config.yaml                    # OpenSpec 生效配置（由模板同步，勿手改三段）
│  ├─ config.template.yaml           # 配置模板（schema/rules/operations 以此为准）
│  ├─ specs/
│  │  └─ .gitkeep
│  ├─ changes/
│  │  └─ .gitkeep
│  └─ templates/                     # 仅框架扩展：context.md / review-report.md / tasks 派发示例
│     ├─ README.md
│     ├─ context.md
│     ├─ tasks.md
│     └─ review-report.md
└─ .gitignore                        # 源码专用（忽略 .opencode/ 等本地目录）
```
