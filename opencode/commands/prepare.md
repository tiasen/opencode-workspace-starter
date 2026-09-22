---
description: 检查 workspace 各仓是否就位（当前检出、路径可解析、仓库存在、AGENTS.md 齐全、worktree 完整），结果对话内回报，不写文件
---

# /prepare — workspace 就位检查

> 在 workspace-root 以 Orchestrator 身份运行：`/prepare`。
> 本命令是**无状态检查**：只读、只验证、不写任何文件，结果直接在对话内回报。
> 派发依据永远是 live 来源（`.code-workspace` + 各仓 `AGENTS.md` + 当次 Change 文档），不存在也不需要快照文件。

## 目标

在新建 Change 开工前，确认**当前所在的检出**与 `.code-workspace` 中的每个 folder 真实可用，避免 Orchestrator 基于不存在的仓库、或错误的检出（主树 vs worktree）做设计与派发。

## 执行步骤

1. **判断当前检出**：运行 `node scripts/worktree.mjs which`（等价于从 cwd 向上查找 `.worktree.jsonc`）。
   - 在 worktree 内 → 记录 worktree id 与分支；
   - 在主树 → 明确标注"主树（非 worktree）"。
   回报中必须显式写出这一行——它是"我到底在改哪套检出"的唯一依据。
2. **定位 workspace 文件**：优先使用调用时传入的 workspace 路径，否则按用户自建优先、`template.code-workspace` 兜底的顺序查找（与 `scripts/init.mjs` 一致）；多文件并存时优先与目录同名者。
3. **解析 folders**：列出全部 `name` 与 `path`，用 `path.resolve` 规范化为绝对路径。`name` 缺失时按 VS Code 规则取路径 basename。
4. **逐仓检查**（每个 folder，只检查、不写）：
   - 路径是否存在；不存在则标记为 `missing`（缺仓不阻塞命令本身，但必须在回报中明确列出）。
   - `{repo}/AGENTS.md` 是否存在；存在则摘录一句话：技术栈 + 验证命令。
   - 本仓技能：列出 `{repo}/.opencode/skills/*/SKILL.md`（或 `.claude/skills/`、`.agents/skills/`）的技能名 + `AGENTS.md` 中的技能声明。技能留在各仓、框架只引用，见 `AGENTS.md` 第 2 节技能引用原则。
   - 当前分支（`git -C <path> rev-parse --abbrev-ref HEAD`）。若在 worktree 内，各成员分支应等于 worktree id；在主树则应停在基线分支。
   - 若为 git 仓库，仅记录工作区洁净度（`git status --short --branch` 一眼结论），**不记录、不比对 commit hash**——执行依据永远是 live 代码，快照式 pin 不再维护。
5. **worktree 完整性**（仅在 worktree 内时）：运行 `node scripts/worktree.mjs doctor`。
   - 任一成员缺失、目录被移动、分支不一致 → 检出**不完整**，**禁止派发**，先修复（`node scripts/worktree.mjs doctor` 会给出具体项）。
6. **对话内回报**（不写文件），格式如下：

```markdown
## Prepare: {workspace 文件名}

**当前检出**: worktree `feat-a`（branch feat-a） / 主树（非 worktree）

| 仓库 | 路径 | 状态 | 分支 | AGENTS.md | 技能 |
|------|------|------|------|-----------|------|
| workspace-root | `.` | OK | feat-a | —（本仓即 Orchestrator 所在仓） | {框架级 skill 名} |
| frontend | `../frontend` | OK / MISSING | feat-a | 有（React + TS，`npm run typecheck`）/ 缺失 | {仓技能名：用途} / 无 |
| backend | `../backend` | OK（dirty：2 个未提交文件）/ MISSING | feat-a | 有 / 缺失 | {仓技能名：用途} / 无 |

缺失仓：{列出 missing 的仓，后续 Change 设计不得依赖它们，先解决检出问题}
worktree 完整性：{完整 / 不完整（列出问题）/ 不适用（主树）}
```

## 约束

- 本命令只读业务仓，**不写任何文件**（包括 `openspec/`）。
- 不派发 Writer / Reviewer，不创建新的 Spec Change。
- 发现缺仓或缺 `AGENTS.md` 时如实回报，由 Orchestrator 决定是先补齐还是缩小 Change 范围。
- 在 worktree 内且完整性不通过时，**不得进入派发**：并行检出的"不可分割"正是靠这一步守住的。
