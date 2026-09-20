/**
 * template-map.mjs — 「源码模板 → 用户项目」的路径映射与清单（create / upgrade 共用）
 *
 * 背景：本仓库是 starter 的源码。面向用户的模板目录是 `opencode/`（无点），
 * scaffold/upgrade 时映射成用户项目的 `.opencode/`；源码自己的 `.opencode/`
 * 只是本机开发/运行时目录，不应提交、也不应复制给用户。
 * 集中定义在这里，避免 create 与 upgrade 两处清单漂移。
 */

/** 顶层条目重命名（源码名 → 用户项目名）。 */
export const RENAME = {
  opencode: ".opencode",
  "template.gitignore": ".gitignore",
};

/** scaffold 时跳过的顶层条目（源码仓库自身或用户自带的文件）。 */
export const SCAFFOLD_SKIP = new Set([
  ".git",
  ".github",
  ".githooks",
  ".opencode",
  "node_modules",
  ".DS_Store",
  ".opencode-cache",
  ".gitignore", // 用户侧 .gitignore 来自 template.gitignore
  "package.json", // 由 buildUserPackageJson 生成
  "bin", // 仅脚手架自身需要，用户项目不需要
  "LICENSE",
]);

/** 递归复制时始终跳过的目录/文件名。 */
export const COPY_EXCLUDE = new Set([".git", "node_modules", ".DS_Store", ".opencode-cache"]);

/** 框架拥有的目录映射（upgrade 覆盖）：[包内目录, 用户项目目录] */
export const FRAMEWORK_DIRS = [
  ["opencode/agents", ".opencode/agents"],
  ["opencode/commands", ".opencode/commands"],
  ["scripts", "scripts"],
  ["openspec/templates", "openspec/templates"],
];

/** 框架拥有的单文件映射（upgrade 覆盖）：[包内文件, 用户项目文件] */
export const FRAMEWORK_FILES = [
  ["AGENTS.md", "AGENTS.md"],
  ["openspec/FRAMEWORK.md", "openspec/FRAMEWORK.md"],
  ["openspec/config.template.yaml", "openspec/config.template.yaml"],
];

/** 用户拥有、upgrade 绝不触碰的路径（仅文档/自检用）。 */
export const USER_OWNED = [
  "*.code-workspace",
  "opencode.jsonc",
  "openspec/config.yaml",
  "openspec/specs/**",
  "openspec/changes/**",
  ".opencode/agents/*-writer.md",
  ".opencode/commands/opsx-*.md",
  ".opencode/skills/**",
  "README.md",
  ".gitignore",
  "package.json",
];

/** 框架维护的 npm scripts（create 生成、upgrade 合并；不覆盖用户其他 scripts 键）。 */
export const FRAMEWORK_SCRIPTS = {
  init: "node scripts/init.mjs",
  context: "opencode run --command prepare",
  "sync:config": "node scripts/sync-config.mjs",
  check: "node scripts/check-version.mjs",
  "check:update": "node scripts/upgrade.mjs --check",
  upgrade: "node scripts/upgrade.mjs",
  "hooks:install": "git config core.hooksPath .githooks",
};

/**
 * 生成用户项目的 package.json 内容。
 * version = 已安装的框架版本（由 create/upgrade 维护，文档中约定用户不要手改）。
 */
export function buildUserPackageJson(name, version, extra = {}) {
  return {
    name,
    version,
    private: true,
    type: "module",
    description: "Multi-repo workspace powered by opencode-workspace-starter",
    scripts: { ...FRAMEWORK_SCRIPTS, ...(extra.scripts ?? {}) },
    engines: { node: ">=24.0.0" },
    ...extra,
  };
}
