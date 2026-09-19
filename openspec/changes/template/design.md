# Design: {change-name}

## 跨仓技术方案概述

前端将登录与续期调用收敛到统一的 `SessionClient`，后端新增 `/api/v2/session` 系列接口并输出 OpenAPI，前端类型由 `openapi-typescript` 从后端产物单向生成。兼容期内后端双版本共存，前端特性开关控制灰度。

## 接口契约

### POST /api/v2/session（登录）

请求：

```json
{
  "username": "alice",
  "password": "s3cr3t"
}
```

响应（201）：

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9.payload.sig",
  "refreshToken": "r-9f2c4a1b",
  "expiresAt": "2026-09-26T12:00:00Z",
  "tokenType": "Bearer"
}
```

### POST /api/v2/session/refresh（续期）

请求：

```json
{
  "refreshToken": "r-9f2c4a1b"
}
```

响应（200）：与登录响应同形，`refreshToken` 轮换为新值，旧值 60 秒宽限期内仍可用。

错误（任何接口）：

```json
{
  "code": "INVALID_CREDENTIALS",
  "message": "用户名或密码错误",
  "requestId": "req-8d21"
}
```

`code` 枚举：`INVALID_CREDENTIALS | TOKEN_EXPIRED | TOKEN_REUSED | RATE_LIMITED | INTERNAL`。

## 数据流

1. 用户提交登录表单 → `SessionClient.login()` → `POST /api/v2/session` → 存储 token 对与 `expiresAt`。
2. 请求拦截器在 `expiresAt - 60s` 前触发 `POST /api/v2/session/refresh`，并发请求合并为单次续期。
3. 续期失败（`TOKEN_EXPIRED`）→ 清除本地会话 → 跳转登录页并保留回跳地址。
4. 灰度开关 `sessionV2=true` 的用户走 v2，否则走 v1；开关由后端 `/api/v2/config` 下发。

## 错误处理策略

- 网络超时重试 1 次（仅幂等的 refresh 接口），login 不自动重试。
- `RATE_LIMITED` 时按 `Retry-After` 退避，前端展示“稍后重试”。
- 后端对 token 复用（`TOKEN_REUSED`）直接吊销该会话全量 token 并记审计日志。

## 风险与回滚

| 风险 | 等级 | 缓解 |
|------|------|------|
| 双版本 session 并存导致登出不同步 | 高 | 登出接口同时吊销 v1/v2 token，后端单点吊销 |
| 时钟漂移导致提前过期判断错误 | 中 | 以服务端 `expiresAt` 为准，客户端留 60s 裕量 |
| OpenAPI 生成类型漂移 | 中 | CI 中加入 `openapi diff` 检查，漂移即失败 |

回滚：关闭 `sessionV2` 开关即回退到 v1；v2 接口保留但前端零流量，可独立下线。

## 按仓职责

- **backend**：实现 v2 接口、OpenAPI 输出、双版本吊销、审计日志。详见 `specs/backend.md`。
- **frontend**：实现 `SessionClient`、请求拦截器续期、特性开关、由 OpenAPI 生成类型。详见 `specs/frontend.md`。
