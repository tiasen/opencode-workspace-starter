#!/usr/bin/env node
/**
 * sync-config.mjs — 将 openspec/config.template.yaml 同步到 openspec/config.yaml
 *
 * 设计原则：调用方永远只调这一个命令，顺序依赖在内部解决。
 *   - openspec/config.yaml 存在 → 分段合并后写回（schema/rules/operations
 *     三段以模板为准，其余顶层键原样保留；连续跑两次零 diff）。
 *   - openspec/config.yaml 缺失 → 按模板全文建出（含 openspec/specs、openspec/changes
 *     占位），并提示日后补跑 `openspec init` 安装官方命令集成。
 *   - 不自动运行 `openspec init`：它是第三方交互式脚手架，自动跑有覆盖风险；
 *     需要官方 /opsx-* 命令请装好 CLI 后执行 openspec init --tools opencode --force。
 *
 * 用法:
 *   node scripts/sync-config.mjs [--root <path>] [--check] [--help]
 *   npm run sync:config
 *
 *   --root <path>  workspace-root（默认: 本包所在仓库根，即上两级目录）
 *   --check        只比较不写入；不一致时退出码 1（给 CI 用）
 *
 * 零依赖：仅 Node 内置模块。YAML 只做顶层 key 分段处理（config.yaml 结构固定），
 * 不引入解析器。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncConfig } from "./sync-config-lib.mjs";

function printHelp() {
  process.stdout.write(
    `用法: node scripts/sync-config.mjs [--root <path>] [--check] [--help]\n` +
      `  将 openspec/config.template.yaml 同步到 openspec/config.yaml。\n`
  );
}

function parseArgs(argv) {
  const args = { root: null, check: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) args.root = argv[++i];
    else if (a.startsWith("--root=")) args.root = a.slice("--root=".length);
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`[error] 未知参数: ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const root =
    args.root != null
      ? path.resolve(process.cwd(), args.root)
      : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const result = syncConfig({ root, check: args.check });
  for (const line of result.messages) process.stdout.write(`${line}\n`);
  if (args.check && result.changed) {
    process.stderr.write(
      `[error] openspec/config.yaml 与模板不一致，运行 npm run sync:config 同步。\n`
    );
    process.exit(1);
  }
}

main();
