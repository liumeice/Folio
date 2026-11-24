/* 导出 PDF 的目标文件名（FR-13.2）：文档文件名 → Windows 安全的 `<名>.pdf`。
 * 纯函数（无 DOM 依赖），断言在 tests/unit/pdfname.test.ts。
 * 规则：剥 .md/.markdown/.txt 后缀 → 非法字符（<>:"/\|?* + 控制符）替换为「·」
 *       → 去尾点/尾空格（Windows 静默剥离，留着会指向另一个文件）→ 保留名加下划线前缀。
 * P4b：空标题回退名按当前 UI 语言生成（pdf.fallbackName）；已有文件名不翻译。 */
import { t } from "./i18n/index.ts";

const ILLEGAL = /[<>:"/\\|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function pdfExportName(fileName: string): string {
  let base = fileName.replace(/\.(md|markdown|txt)$/i, "");
  base = base.replace(/[\x00-\x1f]/g, "").replace(ILLEGAL, "·");
  base = base.replace(/[. ]+$/, "").trim();
  if (!base || /^·+$/.test(base)) base = t("pdf.fallbackName");   // 全非法 → 净化后只剩一串「·」也算空
  if (RESERVED.test(base)) base = "_" + base;
  return base + ".pdf";
}
