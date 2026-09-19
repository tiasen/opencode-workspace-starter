# OpenSpec SDD — 协作规范（SDD = Spec-Driven Development，规约驱动开发）

> 本文件约束 `openspec/` 目录下所有 Spec Change 的结构与生命周期。Orchestrator 与 Reviewer 均需遵守。

## 1. 目录结构

```text
openspec/
├── AGENTS.md               # 本规范文件
├── repo-context.md         # 由 /prepare 生成的各仓摘要索引（git-ignored 可选提交）
├── specs/                  # 基线 spec（跨 change 的长期契约，可选）
└── changes/
    ├── .gitkeep
    └── {change-name}/
        ├── proposal.md     # 背景、目标、非目标、成功标准
        ├── context.md      # 全局背景、技术约束、受影响仓库清单
        ├── design.md       # 跨仓技术方案、接口契约、数据流、风险
        ├── tasks.md        # 可派发的原子任务列表
        ├── review-report.md# Reviewer 审查报告
        └── specs/
            ├── {repo-a}.md # 该仓的 delta spec
            └── {repo-b}.md # 该仓的 delta spec
```

`openspec/changes/template/` 提供上述六个文件的空白模板，新建 Change 时整目录复制。

## 2. 命名规范

- `{change-name}` 使用小写 kebab-case，例如 `user-auth-v2`、`billing-currency-migration`。
- `specs/{repo}.md` 的文件名必须与 `.code-workspace` 中的 folder `name` 一致（例如 `frontend.md`、`backend.md`），以便 Orchestrator 与 Writer 精确定位专属契约。
- Task 编号从 1 递增，Remediation Task 在原有编号后追加，不得复用已关闭 Task 的编号。

## 3. 各文件写作要求

### proposal.md

包含：背景（为什么做）、目标（做成什么样）、非目标（明确不做什么）、成功标准（可验收的条目）。不超过两页，面向非实现细节的读者也能理解。

### context.md

包含：全局背景、受影响仓库清单（含各仓当前 commit hash）、技术约束（版本、兼容性、时间窗口）、术语表。必须列出本次 Change 涉及的全部仓库及其 `AGENTS.md` 关键约束摘要。

### design.md

包含：跨仓技术方案、接口契约（请求/响应 schema）、数据流图（文字描述即可）、错误处理策略、风险与回滚方案。接口契约是 Reviewer 的审查基准，必须精确到字段级。

### specs/{repo}.md

每个仓一份 delta spec，只描述该仓的变更：修改范围（文件列表）、接口/类型变更、前后行为对比、迁移步骤、验收命令。Writer 以此文件为主文件执行任务。

### tasks.md

格式见 `changes/template/tasks.md`。每个 Task 必须包含：Assignee（`{repo}-writer`）、Status（`pending | in_progress | done | failed`）、上下文文件链接组、修改范围、Acceptance 清单。Remediation Task 必须额外引用 `review-report.md` 的问题编号。

### review-report.md

格式见 `changes/template/review-report.md`。仅 Reviewer 可写。`Status` 只能是 `PENDING | PASSED | FAILED` 之一。`FAILED` 时必须逐项列出 `Target`、`Issue`、`Action Required`。

## 4. 生命周期

```text
draft → tasks-dispatched → implementing → reviewing → (remediating → reviewing)* → done
```

- `draft`：proposal / context / design / specs 编写中，尚未派发。
- `tasks-dispatched`：`tasks.md` 已生成并已通过 Task 工具派发。
- `implementing`：Writer 执行中。
- `reviewing`：已唤起 `@reviewer`，等待 `review-report.md`。
- `remediating`：Review FAILED，已生成 Remediation Task 并重新派发。
- `done`：Review PASSED，Orchestrator 已总结汇报。

状态不单独存储，通过 `tasks.md` 中各 Task 的 Status 与 `review-report.md` 的 Status 推导。

## 5. 权限规则

- Orchestrator：可写本目录下除 `review-report.md` 外的所有文件。
- Writer：只读本目录（通过 `external_directory` 获得），不可写。
- Reviewer：只写各 Change 下的 `review-report.md`，其余只读。

任何违反上述权限的写入都应被视为流程事故并回滚。
