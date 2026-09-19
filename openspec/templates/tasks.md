# Tasks: {change-name}

> Orchestrator 在 `tasks.md` 生成完毕后，必须使用 OpenCode Task 工具按 Assignee 派发。
> Prompt 模板见根目录 `AGENTS.md` 第 4.3 节。无依赖的 Task 并发派发，有依赖的按顺序派发。
>
> 铁律（见 `AGENTS.md` 4.5）：① 派发前必须已运行 `/prepare` 确认各仓就位，Prompt 写入本仓上下文（路径 + 验证命令，live 取值，无快照）；
> ② 一个 Task 只归属一个仓库，修改范围严禁横跨 ≥2 个仓，违例打回重拆。

## Task 1: 后端实现 /api/v2/session 系列接口

- **Assignee**: backend-writer
- **Status**: pending

### 上下文文件链接组

| 文件 | 用途 | 必读 |
|------|------|------|
| `openspec/changes/{change-name}/context.md` | 全局背景 | ✅ |
| `openspec/changes/{change-name}/design.md` | 跨仓技术方案 | ✅ |
| `openspec/changes/{change-name}/specs/backend/spec.md` | **专属 delta spec（主文件）** | ✅ |

### 修改范围

- `src/routes/session.ts`
- `src/services/session-service.ts`
- `openapi.yaml`

### Acceptance

- [ ] `POST /api/v2/session` 与 `POST /api/v2/session/refresh` 按 design.md 契约返回
- [ ] `openapi.yaml` 已同步更新
- [ ] `npm test` 通过

## Task 2: 前端实现 SessionClient 与续期拦截器

- **Assignee**: frontend-writer
- **Status**: pending

### 上下文文件链接组

| 文件 | 用途 | 必读 |
|------|------|------|
| `openspec/changes/{change-name}/context.md` | 全局背景 | ✅ |
| `openspec/changes/{change-name}/design.md` | 跨仓技术方案 | ✅ |
| `openspec/changes/{change-name}/specs/frontend/spec.md` | **专属 delta spec（主文件）** | ✅ |

### 修改范围

- `src/api/session-client.ts`
- `src/api/http-interceptor.ts`
- `src/types/session.generated.ts`

### Acceptance

- [ ] 登录 / 续期 / 登出均走 `/api/v2/session` 前缀
- [ ] 类型文件由 OpenAPI 生成，无手写重复定义
- [ ] `npm run typecheck` 通过

## Task 3: 联调与灰度开关验证（依赖 Task 1、Task 2）

- **Assignee**: frontend-writer
- **Status**: pending

### 上下文文件链接组

| 文件 | 用途 | 必读 |
|------|------|------|
| `openspec/changes/{change-name}/context.md` | 全局背景 | ✅ |
| `openspec/changes/{change-name}/design.md` | 跨仓技术方案 | ✅ |
| `openspec/changes/{change-name}/specs/frontend/spec.md` | **专属 delta spec（主文件）** | ✅ |

### 修改范围

- `src/config/feature-flags.ts`

### Acceptance

- [ ] `sessionV2` 开关开 / 关两种状态下登录链路均可用
- [ ] 续期并发合并生效（单次 refresh 只发一个请求）
- [ ] 回报验证结果与未解决风险
