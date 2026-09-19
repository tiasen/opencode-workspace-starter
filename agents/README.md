# Agents 目录

本目录存放由 `npm run init`（`scripts/init.mjs`）自动生成的 Sub-Agent 配置。

| 文件 | 说明 |
|------|------|
| `{repo}-writer.jsonc` | 每个业务仓库一个 Writer，`mode: "subagent"`，`permission.edit` 物理锁定为本仓路径（如 `../frontend/**`）。通过 OpenCode Task 工具由 Orchestrator 唤起。 |
| `reviewer.jsonc` | 跨仓一致性审查员，`mode: "subagent"`，只读所有仓，只写 `openspec/changes/*/review-report.md`。 |

## 约定

- 所有文件均含 `mode: "subagent"` 与清晰的 `description`，以便 OpenCode 进行语义分发。
- 不要手动编辑本目录下的路径，仓库增删改请更新 `.code-workspace` 后重新运行 `npm run init`。
- Writer 的 `instructions` 同时引用根 `AGENTS.md` 与本仓 `{repo}/AGENTS.md`，以后者（子仓约束）为准处理冲突。
- หาก需要新增仓库：往 `.code-workspace` 的 `folders` 追加一项，运行 `npm run init -- --yes`，即可生成新的 `{repo}-writer.jsonc`，同时 `opencode.jsonc` 中的 `permission.task` 会自动追加授权。

## 示例

`agents/frontend-writer.jsonc` 由以下 folder 条目生成：

```json
{ "name": "frontend", "path": "../frontend" }
```

生成结果（作用域锁定单仓）：

```jsonc
{
  "mode": "subagent",
  "description": "负责修改 frontend 仓库代码与契约实现的 Sub-Agent",
  "permission": {
    "edit": {
      "../frontend/**": "allow"
    },
    "external_directory": {
      "openspec/**": "allow",
      "../**": "allow"
    }
  },
  "instructions": [
    "AGENTS.md",
    "../frontend/AGENTS.md"
  ]
}
```
