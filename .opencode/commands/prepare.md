---
description: 检查 workspace 各仓是否就位（路径可解析、仓库存在、AGENTS.md 齐全），结果对话内回报，不写文件
---

# /prepare — workspace 就位检查

> 在 workspace-root 以 Orchestrator 身份运行：`/prepare`。
> 本命令是**无状态检查**：只读、只验证、不写任何文件，结果直接在对话内回报。
> 派发依据永远是 live 来源（`.code-workspace` + 各仓 `AGENTS.md` + 当次 Change 文档），不存在也不需要快照文件。

## 目标

在新建 Change 开工前，确认 `.code-workspace` 中的每个 folder 真实可用，避免 Orchestrator 基于不存在的仓库做设计。

## 执行步骤

1. **定位 workspace 文件**：优先使用调用时传入的 workspace 路径，否则按用户自建优先、`template.code-workspace` 兜底的顺序查找（与 `scripts/init.mjs` 一致）；多文件并存时优先与目录同名者。
2. **解析 folders**：列出全部 `name` 与 `path`，用 `path.resolve` 规范化为绝对路径。`name` 缺失时按 VS Code 规则取路径 basename。
3. **逐仓检查**（每个 folder，只检查、不写）：
   - 路径是否存在；不存在则标记为 `missing`（缺仓不阻塞命令本身，但必须在回报中明确列出）。
   - `{repo}/AGENTS.md` 是否存在；存在则摘录一句话：技术栈 + 验证命令。
   - 若为 git 仓库，仅记录工作区洁净度（`git status --short --branch` 一眼结论），**不记录、不比对 commit hash**——执行依据永远是 live 代码，快照式 pin 不再维护。
4. **对话内回报**（不写文件），格式如下：

```markdown
## Prepare: {workspace 文件名}

| 仓库 | 路径 | 状态 | AGENTS.md |
|------|------|------|-----------|
| workspace-root | `.` | OK | —（本仓即 Orchestrator 所在仓） |
| frontend | `../frontend` | OK / MISSING | 有（React + TS，`npm run typecheck`）/ 缺失 |
| backend | `../backend` | OK（dirty：2 个未提交文件）/ MISSING | 有 / 缺失 |

缺失仓：{列出 missing 的仓，后续 Change 设计不得依赖它们，先解决检出问题}
```

## 约束

- 本命令只读业务仓，**不写任何文件**（包括 `openspec/`）。
- 不派发 Writer / Reviewer，不创建新的 Spec Change。
- 发现缺仓或缺 `AGENTS.md` 时如实回报，由 Orchestrator 决定是先补齐还是缩小 Change 范围。
