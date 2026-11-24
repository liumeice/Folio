/* 文件名校验（目录树右键「重命名」，《Folio-目录树文件重命名方案》§3.1/§4）。
 * 规则与 `src-tauri/src/commands.rs::validate_file_name` 逐条镜像——Rust 侧是权威，
 * 这里只负责在提交前本地拦一道，返回稳定的拒绝原因码（P4a 结构化错误，设计 §4.7.3）；
 * 呈现文案在 i18n 目录 `filename.error.<reason>`，由调用方 `t()` 组装。改一侧必须双跑（tests/unit/filename.test.ts）。 */

/** 校验拒绝原因码（设计附录 B.2；`CONFLICT` 属保存/重命名的外部修改冲突，由 Rust 权威侧产出） */
export type FileReason =
  | "EMPTY"
  | "ILLEGAL_CHARS"
  | "BAD_END"
  | "TOO_LONG"
  | "BAD_EXT"
  | "EXISTS"
  | "NO_DIR";

/** 校验文件名；返回 null=合法，否则=拒绝原因码。与 Rust 同序：空→非法字符→结尾→长度→扩展名 */
export function validateFileName(raw: string): FileReason | null {
  const t = raw.trim();
  if (!t) return "EMPTY";
  if (/[\\/:*?"<>|]/.test(t) || [...t].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    return "ILLEGAL_CHARS";
  }
  if (t.endsWith(".") || t.endsWith(" ")) return "BAD_END";
  if ([...t].length > 255) return "TOO_LONG";
  const lower = t.toLowerCase();
  if (!(lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt"))) {
    return "BAD_EXT";
  }
  return null;
}

/** 文件夹名校验：与文件同规但**没有扩展名一项**（镜像 commands.rs::validate_dir_name） */
export function validateDirName(raw: string): FileReason | null {
  const t = raw.trim();
  if (!t) return "EMPTY";
  if (/[\\/:*?"<>|]/.test(t) || [...t].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    return "ILLEGAL_CHARS";
  }
  if (t.endsWith(".") || t.endsWith(" ")) return "BAD_END";
  if ([...t].length > 255) return "TOO_LONG";
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

/** 就地编辑时默认选中的主文件名长度（不含扩展名）；无主文件名段（如 ".md"）则全选 */
export function baseNameLen(fileName: string): number {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? dot : fileName.length;
}
