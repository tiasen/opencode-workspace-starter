# Review Report: {change-name}

- **Reviewer**: reviewer-agent
- **Status**: PENDING
- **Timestamp**: {timestamp}
- **审查范围**: {涉及的仓，如 frontend、design-docs}

> 仅在 `context.md` 的 Review 判定为"需要审查"时才生成本文件，审查范围以 `context.md` 为准。
> `Status` 只能取 `PENDING | PASSED | FAILED` 之一。
> 本文件仅 Reviewer 可写，Orchestrator 只读并据此决定是否生成 Remediation Task。

## 检查清单（只核对契约面）

- [ ] 接口定义一致性（前端调用的 API 与后端实现契约是否匹配）
- [ ] 数据模型与类型定义一致性
- [ ] 缺省语义 / 判定顺序 / 门控一致性
- [ ] 调用方与实现方是否匹配、是否符合被依赖的他仓规范

> 不做全量回归重跑（见 `AGENTS.md` §4.3 验证去重）；不涉及契约的实现细节记入下方"问题列表"的建议项，不作为 `FAILED` 依据。
> 任务单仓性由派发前的 scope 自检（`AGENTS.md` §4.5 规则二）负责；发现问题只作流程告警，不据此判 `FAILED`。

## 问题列表 (Inconsistencies)

<!-- 若 Status 为 FAILED，在此详细记录，每条必须包含 Target / Issue / Action Required -->

1. **Target**: frontend-writer
   - **Issue**: API 路径使用 `/api/v1/user`，但后端契约写明为 `/api/v2/user`
   - **Action Required**: 更新前端 API 配置文件

## 结论与下一动作

<!-- Orchestrator 将读取此区域以决定是否分发修复任务 -->
<!-- 示例：Status 为 PASSED 时写 "各仓一致，可以合并"；为 FAILED 时逐条列出需追加的 Remediation Task 建议 assignee。 -->

待 Reviewer 填写。
