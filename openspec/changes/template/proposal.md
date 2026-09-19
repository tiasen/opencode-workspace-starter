# Proposal: {change-name}

- **Author**: {orchestrator / 你的名字}
- **Date**: {YYYY-MM-DD}
- **Status**: draft

## 背景

描述业务或技术动机：为什么需要这个变更？当前系统有什么痛点？引用相关的 issue、工单或线上事故编号。

示例：用户登录链路分散在前后端两处实现，token 续期逻辑不一致导致移动端频繁掉线（issue #1234）。

## 目标

用 3–5 条列出本 Change 要达成的结果，每条可验证：

1. 统一前后端 token 续期策略，静默续期成功率达到 99.9%。
2. 登录接口版本收敛到 `/api/v2/session`，旧版本进入 deprecation 期。
3. 跨仓类型定义由后端 OpenAPI 单向生成，前端不再手写。

## 非目标

明确本次不做的事情，避免范围蔓延：

1. 不做 OAuth 第三方登录接入。
2. 不迁移历史 session 数据，只保证新旧 token 双读。
3. 不调整 UI 视觉稿，只改接口调用层。

## 成功标准

- [ ] 前端调用的登录接口与后端实现的契约完全一致（Reviewer PASSED）。
- [ ] `npm run typecheck` 与 `npm test` 在 frontend、backend 均通过。
- [ ] 灰度一周无新增 401 异常。
