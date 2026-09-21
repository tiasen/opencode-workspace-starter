/**
 * workspace-lib.mjs — `.code-workspace` 解析与路径规范化的共享逻辑
 *
 * 被 scripts/init.mjs（派生 Agent 配置）与 scripts/worktree.mjs（创建并行检出）
 * 共用。两处必须用完全一致的 folders 解析规则，否则 Agent 作用域与 worktree
 * 布局会漂移，故集中在此。
 *
 * 零依赖：仅使用 Node 内置模块 fs / path。
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 将任意路径转为 POSIX 风格（正斜杠），保证通配符在各平台一致。 */
export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 去掉 JSONC 注释（// 与 block 注释），保留字符串内的 // 不被误伤。 */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1] ?? "";
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i += 2;
      } else {
        if (c === "\n") out += c;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n;
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 定位与加载 .code-workspace
// ---------------------------------------------------------------------------

/**
 * 定位 `.code-workspace` 文件。
 *
 * 规则（与历史行为一致）：
 *   - 显式传入 --workspace 时按 cwd 解析；
 *   - 否则扫描 root 下的 *.code-workspace，用户自建优先于 template；
 *   - 多个自建文件并存时，优先与目录同名者（create.mjs 按此约定生成），其次字母序；
 *   - 都没有时退回 template.code-workspace。
 *
 * @returns {string|null} 绝对路径；找不到返回 null。
 */
export function findWorkspaceFile({ root, explicit = null }) {
  if (explicit) {
    const p = path.resolve(process.cwd(), explicit);
    return fs.existsSync(p) ? p : null;
  }
  const named = [];
  try {
    for (const f of fs.readdirSync(root)) {
      if (f.endsWith(".code-workspace") && f !== "template.code-workspace") {
        named.push(path.join(root, f));
      }
    }
  } catch {
    // 忽略读取错误，交给调用方处理
  }
  const preferredName = `${path.basename(root)}.code-workspace`;
  named.sort((a, b) => {
    const ap = path.basename(a) === preferredName ? 0 : 1;
    const bp = path.basename(b) === preferredName ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const candidates = [...named];
  const template = path.join(root, "template.code-workspace");
  if (fs.existsSync(template) && !candidates.includes(template)) {
    candidates.push(template);
  }
  return candidates.length > 0 ? candidates[0] : null;
}

/** 解析 workspace 文件；失败抛错。返回 { file, dir, data, folders }。 */
export function loadWorkspace(workspaceFile) {
  const raw = fs.readFileSync(workspaceFile, "utf8");
  let data;
  try {
    data = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new Error(`workspace 文件 JSON 解析失败: ${err.message}`);
  }
  if (!Array.isArray(data.folders) || data.folders.length === 0) {
    throw new Error("workspace 文件缺少非空 folders 数组。");
  }
  return { file: workspaceFile, dir: path.dirname(workspaceFile), data, folders: data.folders };
}

// ---------------------------------------------------------------------------
// 路径规范化（关键逻辑）
// ---------------------------------------------------------------------------

/**
 * 将 workspace folder.path 规范化为「相对 workspace-root 的 POSIX 路径」。
 *
 * 步骤:
 *   a. 以 .code-workspace 文件所在目录为基准 resolve 原始 path
 *      （VS Code 语义：相对路径相对 workspace 文件位置）。
 *   b. 以 workspace-root（默认为 starter 根，即 opencode.jsonc 所在目录）为基准
 *      计算 relative 路径。
 *   c. 转为 POSIX 风格，`.` 保持为 `.`。
 *
 * 这样生成的 `{rel}/**` 通配符与 Orchestrator 运行时的 cwd 一致，
 * 不会因 `..` 解析错位导致越权或误拦截。
 */
export function normalizeFolderPath(folderPath, workspaceFileDir, workspaceRoot) {
  const trimmed = String(folderPath).trim();
  const abs = path.resolve(workspaceFileDir, trimmed === "" ? "." : trimmed);
  const rel = path.relative(workspaceRoot, abs);
  if (rel === "") return ".";
  return toPosix(rel) || ".";
}

export function sanitizeAgentName(name) {
  return (
    String(name)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "repo"
  );
}

/** 该 folder.path 是否为绝对路径（绝对路径会破坏 worktree 的镜像布局）。 */
export function isAbsoluteFolderPath(folderPath) {
  const trimmed = String(folderPath).trim();
  return trimmed !== "" && path.isAbsolute(trimmed);
}

/**
 * 把 folders 规范化为一组 folder 模型。
 *
 * @param {any[]} folders            .code-workspace 的 folders 数组
 * @param {string} workspaceFileDir  workspace 文件所在目录
 * @param {string} workspaceRoot     Agent 相对路径的解析基准
 * @param {{log?:Function,warn?:Function}} [hooks] 日志回调（默认静默）
 * @returns {Array<{originalName,name,rawPath,relPath,absPath,exists,isRoot,isAbsolute}>}
 */
export function buildFolderModels(folders, workspaceFileDir, workspaceRoot, hooks = {}) {
  const log = hooks.log ?? (() => {});
  const warn = hooks.warn ?? (() => {});
  const models = [];
  const seenNames = new Set();
  for (const f of folders) {
    // VS Code 规范里 folder 只有 path 必填，name 可选。
    // name 缺失时模仿 VS Code：取解析后绝对路径的 basename 作为显示名。
    if (!f || typeof f.path !== "string" || String(f.path).trim() === "") {
      warn(`跳过非法 folder 条目（缺少 path）: ${JSON.stringify(f)}`);
      continue;
    }
    const abs = path.resolve(workspaceFileDir, String(f.path).trim());
    const hasName = typeof f.name === "string" && f.name.trim() !== "";
    const rawName = hasName ? f.name : path.basename(abs);
    const name = sanitizeAgentName(rawName);
    if (!hasName) {
      log(`  folder 未指定 name，按 VS Code 规则取路径 basename: "${rawName}"（规范化为 "${name}"）`);
    }
    if (seenNames.has(name)) {
      warn(`folder name 重复 "${rawName}"（规范化为 "${name}"），已跳过重复项。`);
      continue;
    }
    seenNames.add(name);
    const rel = normalizeFolderPath(f.path, workspaceFileDir, workspaceRoot);
    const exists = fs.existsSync(abs);
    models.push({
      originalName: rawName,
      name,
      rawPath: String(f.path).trim(),
      relPath: rel,
      absPath: abs,
      exists,
      isRoot: rel === "." || rel === "",
      isAbsolute: isAbsoluteFolderPath(f.path),
    });
  }
  return models;
}

/**
 * worktree（整套并行检出）的成员路径映射。
 *
 * 镜像规则：实例内 workspace 目录 = `join(worktreeRoot, basename(workspaceFileDir))`，
 * 每个成员落在 `resolve(实例 workspace 目录, folder.rawPath)`。因为相对层级完全一致，
 * 已提交的 `.code-workspace` 在实例里无需任何修改即可正确解析到本实例的成员。
 *
 * @param {string} worktreeRoot 实例根目录（如 .../worktrees/feat-a）
 * @param {string} workspaceFileDir 主树 workspace 文件所在目录
 * @param {string} folderRawPath folder.path 原始值
 * @returns {string} 成员在主树/实例中的绝对路径（同一函数，换 base 即可）
 */
export function resolveMemberPath(baseWorkspaceDir, folderRawPath) {
  return path.resolve(baseWorkspaceDir, folderRawPath);
}

/** 实例内的 workspace 目录（镜像主树 workspace 目录的 basename）。 */
export function worktreeWorkspaceDir(worktreeRoot, workspaceFileDir) {
  return path.join(worktreeRoot, path.basename(workspaceFileDir));
}

/** 从 dir 向上查找包含 .worktree.jsonc 的目录（判断"当前是否在 worktree 内"）。 */
export function findEnclosingWorktree(dir, manifestName = ".worktree.jsonc") {
  let cur = path.resolve(dir);
  // 一直找到文件系统根
  for (;;) {
    const candidate = path.join(cur, manifestName);
    if (fs.existsSync(candidate)) return { root: cur, manifestPath: candidate };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
