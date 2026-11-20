/* 文件名校验（目录树右键「重命名」，《Folio-目录树文件重命名方案》§3.1/§4）。
 * 规则与 `src-tauri/src/commands.rs::validate_file_name` 逐条镜像——Rust 侧是权威，
 * 这里只负责把错误码翻成人话 + 在提交前本地拦一道；改一侧必须双跑（tests/filename.test.ts）。 */

/** 错误码 → 人话文案（UI 规范 v1.1 §8.6 白话口径；码同时出现在 Rust 的 Invalid(msg) 里） */
const REASONS: Record<string, string> = {
  EMPTY: "文件名不能为空",
  ILLEGAL_CHARS: "文件名不能用这些字符：\\ / : * ? \" < > |",
  BAD_END: "文件名不能以句点或空格结尾",
  TOO_LONG: "文件名太长了（最多 255 个字符）",
  BAD_EXT: "只能改成 Folio 支持的类型：.md / .markdown / .txt",
  EXISTS: "同一个文件夹里已经有这个名字的文件",
  NO_DIR: "这个位置到顶了，再往上没法重命名",
};

/** 校验文件名；返回 null=合法，否则=拒绝原因（人话）。与 Rust 同序：空→非法字符→结尾→长度→扩展名 */
export function validateFileName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return REASONS.EMPTY;
  if (/[\\/:*?"<>|]/.test(t) || [...t].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    return REASONS.ILLEGAL_CHARS;
  }
  if (t.endsWith(".") || t.endsWith(" ")) return REASONS.BAD_END;
  if ([...t].length > 255) return REASONS.TOO_LONG;
  const lower = t.toLowerCase();
  if (!(lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt"))) {
    return REASONS.BAD_EXT;
  }
  return null;
}

/** 文件夹名校验：与文件同规但**没有扩展名一项**（镜像 commands.rs::validate_dir_name） */
export function validateDirName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return REASONS.EMPTY;
  if (/[\\/:*?"<>|]/.test(t) || [...t].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    return REASONS.ILLEGAL_CHARS;
  }
  if (t.endsWith(".") || t.endsWith(" ")) return REASONS.BAD_END;
  if ([...t].length > 255) return REASONS.TOO_LONG;
  return null;
}

/** 路径是否落在 oldDir 里（含等于 oldDir 本身）；Windows 大小写不敏感，返回换前缀后的新路径 */
export function swapPathPrefix(p: string, oldDir: string, newDir: string): string | null {
  const pl = p.toLowerCase();
  const od = oldDir.toLowerCase().replace(/[\\/]+$/, "");
  if (pl === od) return newDir + p.slice(od.length);
  if (pl.length > od.length && (p[od.length] === "\\" || p[od.length] === "/") && pl.startsWith(od)) {
    return newDir + p.slice(od.length);
  }
  return null;
}

/** 路径末段（去尾分隔符后），用作文件夹编辑框的初始名与同名空操作判定 */
export function leafNameOf(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return i < 0 ? t : t.slice(i + 1);
}

/** 把 Rust 错误串翻成人话：`invalid argument: EXISTS` → 文案；其余原样（经 fmtErr 链兜底） */
export function renameErrText(msg: string): string {
  const code = /invalid argument: ([A-Z_]+)/.exec(msg)?.[1];
  if (code && REASONS[code]) return REASONS[code];
  if (/CONFLICT/.test(msg)) return "文件在本编辑器之外被修改过，请先保存或重新加载后再重命名";
  return msg;
}

/** 就地编辑时默认选中的主文件名长度（不含扩展名）；无主文件名段（如 ".md"）则全选 */
export function baseNameLen(fileName: string): number {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? dot : fileName.length;
}
