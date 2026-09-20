#!/usr/bin/env node
/**
 * check-version.mjs — 提交前版本号门禁（开发者 / CI 用）
 *
 * 规则：
 *   1. 若相对 base 有"实质性改动"（见 IGNORE_PREFIXES），则 package.json.version
 *      必须高于 base 的版本，否则非零退出（配合 .githooks/pre-push 阻止 push）。
 *   2. base 不可读取（无远端/浅克隆）时仅告警并放行，避免误伤。
 *
 * 用法:
 *   node scripts/check-version.mjs [--base origin/main]
 *   npm run check
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const IGNORE_PREFIXES = [
  "openspec/changes/", // 本地 Change 草稿，不触发版本要求
  ".opencode/", // 本地运行时
  "node_modules/",
];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseSemver(v) {
  const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gt(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return String(a) !== String(b);
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] > B[i];
  }
  return false;
}

function main() {
  const base = arg("--base", "origin/main");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const current = pkg.version;

  let baseVersion;
  try {
    const raw = git(["show", `${base}:package.json`]);
    baseVersion = JSON.parse(raw).version;
  } catch {
    console.log(`[warn] 无法读取 base(${base})，跳过版本对比（视作通过）。`);
    process.exit(0);
  }

  let changed = [];
  try {
    changed = git(["diff", "--name-only", `${base}...HEAD`])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    console.log(`[warn] 无法计算与 ${base} 的差异，跳过版本对比（视作通过）。`);
    process.exit(0);
  }

  const substantive = changed.filter((f) => !IGNORE_PREFIXES.some((p) => f.startsWith(p)));

  if (substantive.length === 0) {
    console.log(`[ok] 相对 ${base} 无实质性改动，无需提升版本。`);
    process.exit(0);
  }

  if (!gt(current, baseVersion)) {
    console.error(`[error] 检测到 ${substantive.length} 个文件的实质性改动，但版本未提升。`);
    console.error(`        base(${base}) = ${baseVersion}，当前 = ${current}`);
    console.error(`        请先提升 package.json.version（如 npm version patch），再 push。`);
    console.error(`        改动文件示例: ${substantive.slice(0, 5).join(", ")}${substantive.length > 5 ? " ..." : ""}`);
    process.exit(1);
  }

  console.log(`[ok] 版本已提升：${baseVersion} → ${current}（${substantive.length} 个改动文件）。`);
}

main();
