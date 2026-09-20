/**
 * sync-config-lib.mjs — openspec config 同步的核心逻辑（被 CLI 与 init.mjs 共用）
 *
 * 零依赖。只做顶层 key 分段合并，不做完整 YAML 解析。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 以模板为准的三段；其余顶层键一律保留用户版本。 */
const MANAGED_KEYS = ["schema", "rules", "operations"];

/**
 * 按顶层 key 切分 YAML 文本。
 * 顶层 key 行：行首无缩进、非注释、形如 `name:`。
 * 返回 { header: string[], order: string[], sections: Map<string, string[]> }。
 */
export function splitSections(text) {
  const header = [];
  const order = [];
  const sections = new Map();
  let cur = null;
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m) {
      cur = m[1];
      if (!sections.has(cur)) {
        sections.set(cur, []);
        order.push(cur);
      }
      sections.get(cur).push(line);
    } else if (cur === null) {
      header.push(line);
    } else {
      sections.get(cur).push(line);
    }
  }
  return { header, order, sections };
}

export function renderDoc(header, order, sections) {
  const out = [...header];
  for (const key of order) {
    out.push(...sections.get(key));
  }
  // 去掉文末多余空行，保证恰好一个换行结尾
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return `${out.join("\n")}\n`;
}

/**
 * 合并：managed 段取模板，其余取线上；顺序 = 线上原顺序 + 缺失的 managed 段（按模板顺序补齐）。
 * liveText 为 null 表示线上文件不存在 → 直接采用模板全文。
 */
export function mergeConfigs(liveText, templateText) {
  const t = splitSections(templateText);
  if (liveText === null || liveText === undefined) {
    return { text: renderDoc(t.header, t.order, t.sections), changed: true };
  }
  const l = splitSections(liveText);
  const order = [...l.order];
  for (const key of t.order) {
    if (MANAGED_KEYS.includes(key) && !order.includes(key)) order.push(key);
  }
  const sections = new Map();
  for (const key of order) {
    if (MANAGED_KEYS.includes(key) && t.sections.has(key)) {
      sections.set(key, t.sections.get(key));
    } else if (l.sections.has(key)) {
      sections.set(key, l.sections.get(key));
    } else if (t.sections.has(key)) {
      sections.set(key, t.sections.get(key));
    }
  }
  const text = renderDoc(l.header, order, sections);
  const norm = (s) => s.replace(/\r\n/g, "\n");
  return { text, changed: norm(text) !== norm(liveText) };
}

/** 自举时写入生效文件的 header（区别于模板 header）。 */
const BOOTSTRAP_HEADER = [
  "# openspec/config.yaml — OpenSpec 项目配置（生效文件）",
  "#",
  "# 由 openspec/config.template.yaml 经 `npm run sync:config` 自动建出：",
  "#   - schema / rules / operations 三段请改模板后同步，勿直接改此文件；",
  "#   - 其余顶层键可自由添加，同步时原样保留。",
  "",
];

/**
 * 同步 openspec/config.yaml。
 * @param {{ root: string, check?: boolean, templatePath?: string }} opts
 * @returns {{ configPath, templatePath, changed, bootstrapped, messages: string[] }}
 */
export function syncConfig({ root, check = false, templatePath = null }) {
  const messages = [];
  const template = templatePath ?? path.join(root, "openspec", "config.template.yaml");
  const configPath = path.join(root, "openspec", "config.yaml");
  if (!fs.existsSync(template)) {
    throw new Error(`模板不存在: ${template}`);
  }
  const templateText = fs.readFileSync(template, "utf8");
  const liveText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;

  if (liveText === null) {
    messages.push(`openspec/config.yaml 不存在，将按模板建出。`);
    if (!check) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.mkdirSync(path.join(root, "openspec", "specs"), { recursive: true });
      fs.mkdirSync(path.join(root, "openspec", "changes"), { recursive: true });
      const t = splitSections(templateText);
      fs.writeFileSync(configPath, renderDoc(BOOTSTRAP_HEADER, t.order, t.sections), "utf8");
      messages.push(`已建出: ${configPath}`);
    }
    messages.push(
      `提示：如需官方 /opsx-* 命令，装好 CLI 后运行 openspec init --tools opencode --force。`
    );
    return { configPath, templatePath: template, changed: true, bootstrapped: true, messages };
  }

  const { text, changed } = mergeConfigs(liveText, templateText);
  if (!changed) {
    messages.push(`openspec/config.yaml 已与模板一致，无需改动。`);
    return { configPath, templatePath: template, changed: false, bootstrapped: false, messages };
  }
  const managedTouched = MANAGED_KEYS.filter((k) => {
    const a = splitSections(liveText).sections.get(k)?.join("\n") ?? null;
    const b = splitSections(text).sections.get(k)?.join("\n") ?? null;
    return a !== b;
  });
  messages.push(`将更新 ${configPath}（模板段变更：${managedTouched.join(", ") || "无"}）。`);
  if (!check) {
    fs.writeFileSync(configPath, text, "utf8");
    messages.push(`已写入: ${configPath}`);
  } else {
    messages.push(`--check 模式：未写入。`);
  }
  return { configPath, templatePath: template, changed: true, bootstrapped: false, messages };
}

export { SCRIPTS_DIR };
