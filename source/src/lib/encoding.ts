/* 编码标签 → 显示文案（2026-11-20 GBK/GB18030 支持）。
 * 标签来自 Rust folio-fs::decode_bytes 的检出结果（DocFull.encoding）：utf-8 / gbk / gb18030。 */
export function encLabel(tag: string | undefined | null): string {
  switch ((tag || "utf-8").toLowerCase()) {
    case "gbk": return "GBK";
    case "gb18030": return "GB18030";
    case "utf-8": return "UTF-8";
    case "utf-16le": return "UTF-16 LE";
    case "utf-16be": return "UTF-16 BE";
    default: return (tag || "UTF-8").toUpperCase();
  }
}
