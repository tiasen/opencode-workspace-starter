# openspec/templates/ — 本框架的扩展文件模板

> 新 Change 的官方四件套（`proposal.md`、`specs/<repo>/spec.md`、`design.md`、`tasks.md`
> 的初稿）由官方命令生成，不要手造：
>
> ```bash
> /opsx-propose {change-name}   # 起草 proposal + specs + design + tasks
> ```
>
> 起草规则来自 `openspec/config.yaml`（由 `openspec/config.template.yaml`
> 经 `npm run sync:config` 同步），改规则请改模板后同步。
>
> 本目录只保留官方 schema 之外的**框架扩展文件**，官方流程建好 Change 后复制进去：

| 文件 | 用途 | 复制时机 |
|------|------|----------|
| `context.md` | 当次全局背景 + 受影响仓库清单（路径/角色/验证命令），Writer 必读 | `/opsx-propose` 之后、派发之前，由 Orchestrator 填写 |
| `review-report.md` | Reviewer 的一致性审查报告（仅 Reviewer 可写） | 判定"需要审查"后、唤起 `@reviewer` 之前放入的空白模板 |
| `tasks.md` | 本框架的 Task 派发格式示例（含 Assignee/Status/链接组/铁律块） | 若官方生成的 tasks 缺少派发元数据，按此补齐 |

注意：`tasks.md` 在官方 schema 里是 checklist；本框架要求每个 Task 带 `Assignee` 与
`Status`（派发必需，见根目录 `AGENTS.md` §4）。`openspec validate` 通过即视为兼容。
