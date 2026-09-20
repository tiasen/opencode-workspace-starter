# Context: {change-name}

- **Change**: `{change-name}`
- **上下文来源**: live 读取（`.code-workspace` + 各仓 `AGENTS.md` + 当次设计），无快照文件

## 全局背景

概述本次变更在整个系统中的位置：涉及哪些用户旅程、哪些服务、上下游依赖。说明与历史 Change 的关系（前置 / 并行 / 冲突）。

## 受影响仓库清单

| 仓库 | 路径 | 当次角色 | 验证命令 |
|------|------|----------|----------|
| workspace-root | `.` | 托管 openspec，不含业务代码 | — |
| frontend | `../frontend` | 调用方：更新登录 API 客户端与类型 | `npm run typecheck` |
| backend | `../backend` | 实现方：提供 `/api/v2/session` 与 OpenAPI | `npm test` |

各仓 `AGENTS.md` 关键约束摘要：

- **frontend**：React + TypeScript，使用 `npm run typecheck` 做类型检查，API 客户端位于 `src/api/`，禁止手写后端已提供的类型。
- **backend**：Node + Express，使用 `npm test` 做契约测试，路由定义位于 `src/routes/`，所有对外接口必须同步更新 `openapi.yaml`。

## Review 判定

- **是否需要跨仓审查**: 是 / 否
- **触发条件**: {命中的条件，如"调用方 / 实现方契约变更"；跳过则写"单仓内部、不改对外契约"}
- **审查范围（仅需审查时）**: {涉及的仓，如 `frontend`、`design-docs`；用户强制全量时写 `.code-workspace` 全部业务仓}
- **判据 / 理由**: {引用各仓 `AGENTS.md` 要求或改动性质}

## 技术约束

1. Node >= 18，前后端共享 `.nvmrc` 版本。
2. 兼容期两周：`/api/v1/session` 与 `/api/v2/session` 双写双读，之后下线 v1。
3. 所有时间字段使用 ISO-8601 UTC 字符串，禁止时间戳数字。
4. 本 Change 时间窗口：{start-date} 至 {end-date}，阻塞发布列车 {train-id}。

## 术语表

| 术语 | 定义 |
|------|------|
| Session | 登录后服务端签发的会话，含 access token 与 refresh token |
| 静默续期 | 在 access token 过期前用 refresh token 自动换取新 token，用户无感知 |
| Delta Spec | 按仓拆分的增量契约，见 `specs/{repo}/spec.md` |
