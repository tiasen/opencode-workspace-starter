# OpenSpec SDD — 协作规范（SDD = Spec-Driven Development，规约驱动开发）

> 本文件约束 `openspec/` 目录下所有 Spec Change 的结构与生命周期。Orchestrator 与 Reviewer 均需遵守。

## 1. 目录结构

```text
openspec/
├── AGENTS.md               # 本规范文件（框架编排层）
├── config.yaml             # OpenSpec 项目配置（生效文件，由 config.template.yaml 同步）
├── config.template.yaml    # 配置模板（schema/rules/operations 以此为准）
├── specs/                  # 基线 spec（跨 change 的长期契约，由 openspec archive 维护）
└── changes/
    ├── .gitkeep
    └── {change-name}/
        ├── .openspec.yaml  # Change 元数据（官方命令自动生成）
        ├── proposal.md     # 背景、目标（官方 artifact）
        ├── context.md      # 全局背景、技术约束、受影响仓库清单（框架扩展）
        ├── design.md       # 跨仓技术方案、接口契约、数据流、风险（官方 artifact）
        ├── tasks.md        # 可派发的原子任务列表（官方格式 + 本框架 Assignee/Status）
        ├── review-report.md# Reviewer 审查报告（框架扩展，仅 Reviewer 可写）
        └── specs/
            ├── {repo-a}/spec.md  # 该仓的 delta spec（capability 目录名 = 仓名）
            └── {repo-b}/spec.md
```

`openspec/templates/` 只存放框架扩展文件（`context.md`、`review-report.md`）与
`tasks.md` 派发格式示例；官方四件套由 `/opsx-propose` 生成（规则见 `config.yaml`），详见
`template/README.md`。项目配置变更流程：改 `config.template.yaml` → 跑 `npm run sync:config`。

## 2. 命名规范

- `{change-name}` 使用小写 kebab-case，例如 `user-auth-v2`、`billing-currency-migration`。
- `specs/{repo}/spec.md` 的 capability 目录名必须与 `.code-workspace` 中的 folder `name` 一致（例如 `specs/frontend/spec.md`、`specs/backend/spec.md`），以便 Orchestrator 与 Writer 精确定位专属 delta spec。delta spec 遵循官方 Requirement/Scenario + ADDED/MODIFIED/REMOVED 格式。
- Task 编号从 1 递增，Remediation Task 在原有编号后追加，不得复用已关闭 Task 的编号。

## 3. 各文件写作要求

官方 artifact（`proposal.md`、`specs/`、`design.md`、`tasks.md`）的格式以官方 schema
为准，项目级约束见 `openspec/config.yaml` 的 `rules` 段；以下只写本框架的增量要求。

### proposal.md（官方）

增量要求：必须写明参与子应用及其当次角色。背景、目标、非目标、成功标准不超过两页。

### context.md

包含：全局背景、受影响仓库清单（含各仓路径、当次角色、验证命令）、技术约束（版本、兼容性、时间窗口）、术语表。必须列出本次 Change 涉及的全部仓库及其 `AGENTS.md` 关键约束摘要。清单现写现用，不设常驻快照；角色是相对当次 Change 而言的，不得理解为仓库固有属性。

### design.md（官方）

增量要求：子应用边界处的接口契约必须精确到字段级——它是 Reviewer 跨仓审查的基准。除此之外包含跨仓技术方案、数据流、错误处理策略、风险与回滚方案。

### specs/{repo}/spec.md

每个仓一个 capability 目录、一份 delta spec，只描述该仓的行为变更：修改范围（文件列表）、接口/类型变更、前后行为对比、迁移步骤、验收命令。Writer 以此文件为主文件执行任务。`context.md` 与 `review-report.md` 是本框架在官方 schema 之上的扩展文件（见下）。

### tasks.md（官方格式 + 框架派发元数据）

官方 checklist 之上，每个 Task 必须包含：Assignee（`{repo}-writer`）、Status（`pending | in_progress | done | failed`）、上下文文件链接组、修改范围、Acceptance 清单（格式示例见 `templates/tasks.md`）。Remediation Task 必须额外引用 `review-report.md` 的问题编号。单仓原子性：一个 Task 只归属一个仓库，其修改范围不得横跨 ≥2 个仓；跨仓工作先拆成多个单仓 Task，依赖用 Task 顺序表达。

### review-report.md

格式见 `templates/review-report.md`。仅 Reviewer 可写。`Status` 只能是 `PENDING | PASSED | FAILED` 之一。`FAILED` 时必须逐项列出 `Target`、`Issue`、`Action Required`。

## 4. 阶段门禁与生命周期（严格遵循官方 OpenSpec）

阶段由用户通过官方 `/opsx-*` 命令显式驱动，**Orchestrator 不得自行推进阶段**：

| 阶段 | 官方命令 | 说明 |
|------|----------|------|
| Explore | `/opsx-explore` | 只讨论、读代码、澄清；**不生成任何 spec** |
| Propose | `/opsx-propose` | 生成官方四件套 + 框架扩展 `context.md`；**完成后停止，等用户 review** |
| Update | `/opsx-update` | 按用户反馈修订 artifacts |
| Apply | `/opsx-apply` | 本框架在此阶段用 Task 工具派发给各仓 Writer，并跑一致性审查闭环 |
| Archive | `/opsx-archive` | delta 合并进基线；仅在用户显式命令后执行 |

> 铁律：`/opsx-propose` 完成后必须停止（官方命令自身要求 "stop ... wait for a new user request"）；
> 未经用户显式 `/opsx-apply`，不得派发任何 Writer；未经用户显式 `/opsx-archive`，不得归档。

内部细粒度状态（仅用于描述，**不作为自动推进依据**）：

```text
draft → awaiting-review → applying → reviewing → (remediating → reviewing)* → reviewed → archived
```

- `draft`：Propose 进行中。
- `awaiting-review`：artifacts 就绪，等用户 review（**禁止自动进入 Apply**）。
- `applying`：Apply 阶段，正在派发。
- `reviewing`：已唤起 `@reviewer`，等待 `review-report.md`。
- `remediating`：Review FAILED，已生成 Remediation Task 并重新派发。
- `reviewed`：Review PASSED，等用户显式 archive。
- `archived`：已归档。

状态不单独存储，通过 `tasks.md` 各 Task 的 Status 与 `review-report.md` 的 Status 推导。

## 5. 审查触发判定

跨仓一致性审查**不是每次必跑**，由 Orchestrator 按"改动性质 + 涉及仓 + 各仓 `AGENTS.md` 要求"判定，并记入 `context.md`：

- **触发**：跨仓契约变更（接口 / 类型 / 事件 / 协议 / 配置）；≥2 仓存在调用或上下游关系；改动须符合他仓拥有的规范（如设计仓 `DESIGN.md`）；目标仓 `AGENTS.md` 要求审查；用户显式要求。
- **可跳过（须记理由）**：单仓内部且不改对外契约（纯 UI / 样式 / 文案 / 内部重构）；临时或一次性产物（脚本、实验、不交付）；仅注释 / 文档措辞；用户声明无需审查。
- **范围**：默认只覆盖涉及仓与对应 Writer；仅用户强制"全量一致性检查"时覆盖所有业务仓。
- 判不准时倾向执行，并在 Propose 的 review gate 呈给用户确认。

## 6. 权限规则

- Orchestrator：可写本目录下除 `review-report.md` 外的所有文件。
- Writer：只读本目录（通过 `external_directory` 获得），不可写。
- Reviewer：只写各 Change 下的 `review-report.md`，其余只读。

任何违反上述权限的写入都应被视为流程事故并回滚。
