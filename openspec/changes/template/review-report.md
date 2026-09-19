# Review Report: {change-name}

- **Reviewer**: reviewer-agent
- **Status**: PENDING
- **Timestamp**: {timestamp}

> `Status` 只能取 `PENDING | PASSED | FAILED` 之一。
> 本文件仅 Reviewer 可写，Orchestrator 只读并据此决定是否生成 Remediation Task。

## 检查清单

- [ ] 接口定义一致性（前端调用的 API 与后端实现契约是否匹配）
- [ ] 数据模型与类型定义一致性
- [ ] 架构约束遵循情况

## 问题列表 (Inconsistencies)

<!-- 若 Status 为 FAILED，在此详细记录，每条必须包含 Target / Issue / Action Required -->

1. **Target**: frontend-writer
   - **Issue**: API 路径使用 `/api/v1/user`，但后端契约写明为 `/api/v2/user`
   - **Action Required**: 更新前端 API 配置文件

## 结论与下一动作

<!-- Orchestrator 将读取此区域以决定是否分发修复任务 -->
<!-- 示例：Status 为 PASSED 时写 "各仓一致，可以合并"；为 FAILED 时逐条列出需追加的 Remediation Task 建议 assignee。 -->

待 Reviewer 填写。
