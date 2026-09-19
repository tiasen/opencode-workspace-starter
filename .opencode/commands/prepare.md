---
description: 生成跨仓上下文索引 openspec/repo-context.md（各仓 AGENTS.md 摘要 + commit hash）
---

# /prepare — 生成跨仓上下文索引

> 在 workspace-root 以 Orchestrator 身份运行：`/prepare`。
> 产物：`openspec/repo-context.md`，供后续所有 Spec Change 的 `context.md` 与任务派发时参考。

## 目标

读取 `.code-workspace` 中的每个 folder，汇总各仓库的协作约束与当前状态，生成一份摘要索引，避免 Orchestrator 每次都全量扫描代码。

## 执行步骤

1. **定位 workspace 文件**：优先使用调用时传入的 workspace 路径，否则按用户自建优先、`template.code-workspace` 兜底的顺序查找（与 `scripts/init.mjs` 一致）。
2. **解析 folders**：列出全部 `name` 与 `path`，用 `path.resolve` 规范化为绝对路径，并标注是否存在。`name` 缺失时按 VS Code 规则取路径 basename。
3. **逐仓采集**（每个 folder）：
   - 读取 `{repo}/AGENTS.md` 全文，提取：技术栈、目录约定、lint / typecheck / test 命令、分支与提交规范。
   - 若为 git 仓库，运行 `git -C {repo} rev-parse HEAD` 记录 commit hash，运行 `git -C {repo} status --short --branch` 记录工作区洁净度。
   - 若 `package.json` 存在，记录 `name`、`version` 与关键 `scripts`。
   - 若目录不存在，标记为 `missing` 并跳过细节采集。
4. **生成 `openspec/repo-context.md`**，格式如下：

```markdown
# Repo Context Index

- **GeneratedAt**: {ISO-8601 时间戳}
- **Workspace**: {workspace 文件名}
- **OrchestratorCommit**: {workspace-root 的 HEAD}

## frontend (`../frontend`)
- **AbsPath**: {/abs/path/to/frontend}
- **Commit**: {40 位 hash 或 missing}
- **Status**: {clean / dirty / missing}
- **Stack**: {从 AGENTS.md 提取}
- **Commands**: `npm run lint`, `npm run typecheck`, `npm test`
- **Constraints**: {逐条摘录，不超过 10 条}

## backend (`../backend`)
-（同上结构）
```

5. **校验**：若某仓 `Commit` 与上次生成的记录不一致，在文件顶部追加 `> 注意：{repo} 的 commit 已从 {old} 变为 {new}` 提示行，提醒 Orchestrator 以最新代码为准。
6. **回报**：向用户输出各仓 `name → commit（短 hash）→ 状态` 一览，以及缺失仓列表。

## 约束

- 本命令只读业务仓，只写 `openspec/repo-context.md`。
- 不派发 Writer / Reviewer，不创建新的 Spec Change。
- 采集到的 `AGENTS.md` 摘要必须保留原文关键动词，不得意译为模糊表述。
