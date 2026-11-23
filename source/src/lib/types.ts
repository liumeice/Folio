/* 与 folio-core serde(camelCase) 一一对应 */

export interface DocMeta {
  id: number;
  path: string;
  slug: string;
  title: string;
  dir: string;
  fileName: string;
  size: number;
  mtime: number;
  wordCount: number;
  headCount: number;
  secCount: number;
  /** 文档库成员：位于已登记库根之下（由「打开文件夹…」产生）。打开单个文件不再入库。 */
  inLibrary: boolean;
  /** 置顶：只对库成员有意义的分组标记 */
  pinned: boolean;
  /** 内置文档（欢迎页）：不入库，也不被「清空最近打开」回收 */
  builtin: boolean;
}

/** 「最近打开」条目 = 登记条目 + 最近一次打开时刻（unix 秒，与 mtime 同单位） */
export interface RecentDoc {
  meta: DocMeta;
  openedAt: number;
}

/** 清空打开历史的结果：清掉多少条历史 / 顺带回收多少条失去归属的登记 */
export interface RecentReport {
  cleared: number;
  pruned: number;
}

export interface OutlineItem {
  sec: number;
  level: number;
  text: string;
  line: number;
}

export interface DocFull {
  meta: DocMeta;
  src: string;
  outline: OutlineItem[];
  /** 来源编码标签（utf-8 / gbk / gb18030，2026-11-20 GBK 支持）：src 恒为解码后的 UTF-8
   *  内存文本，本标签只决定保存/另存为回写磁盘用哪套字节（缺省按 utf-8）。 */
  encoding: string;
}

export interface Position {
  ratio: number;
  sec: number | null;
  secText: string | null;
  secOff: number;
  /** v1.2 恢复主坐标：章节内源码行偏移（-1=无值；无标题文档时相对第 0 行=绝对行）。
   *  布局无关，免疫塌陷期 ratio 污染（方案 §4.3）；持久列 positions.sec_line_off（schema v6） */
  secLineOff: number;
  updatedAt: number;
  /** 运行期字段（不落库）：视口顶小数源码行号，供 HistEntry.lineFloat 与调试 */
  srcLine?: number | null;
  /** 运行期字段（不落库）：采集瞬间的原始 scrollTop，供版式不变的原位更新（如勾选）精确复位 */
  scrollY?: number | null;
}

export interface Settings {
  theme: "dark" | "light" | "sepia";
  /** 强调色 hex（如 "#2DD4BF"）；"" = 跟随主题内置强调色。派生色由 lib/accent.ts 计算 */
  accent: string;
  serif: boolean;
  fsSerif: number;
  fsSans: number;
  width: number;
  lh: number;
  libraryRoot: string | null;
  scanLimit: number | null;
  /** 左侧面板宽度 px（拖分隔条得到；null = 用默认 266） */
  sideWidth: number | null;
  /** 正文字距 em（0–0.12） */
  letterSpacing: number;
  /** 段落间距 em（0.6–2.0，相对正文字号） */
  paraSpacing: number;
  /** 正文对齐 */
  align: "left" | "justify";
  /** 代码块字号 px（11–14，独立于正文） */
  codeFs: number;
  /** 表格密度 */
  tableDensity: "compact" | "standard" | "loose";
  /** 启动时自动打开并恢复上次关闭时的文档（false = 空态启动，加快冷启动；需求方 2026-11-18） */
  restoreOnLaunch: boolean;
  /** 段落内单个换行按换行显示（false = 按 GFM 折叠为空格；true = 逐行显示，需求 2026-11-23） */
  softBreakBr: boolean;
}

export type SearchScope = "current" | "library";

export interface SearchQuery {
  text: string;
  scope: SearchScope;
  docId: number | null;
  limit?: number;
  /** scope=current 时可直传眼前正文（阅读 src 或编辑缓冲），省一次读盘且搜的是未保存内容 */
  src?: string | null;
}

export interface SearchHit {
  docId: number;
  docPath: string;
  docTitle: string;
  sec: string;
  secAnchor: number | null;
  /** 命中词以 « » 包裹（渲染时替换为 <em>，先经 escape） */
  snippet: string;
  count: number;
  isHeading: boolean;
}

export interface ScanReport {
  root: string;
  total: number;
  inserted: number;
  updated: number;
  removed: number;
  skipped: number;
  unchanged: number;
  /** v4 单库策略：本次「打开文件夹」替换掉的旧库根（若有） */
  prevRoot: string | null;
  /** 旧库根下随之出库（降级为仅最近打开）的条数 */
  prevDemoted: number;
  /** 达到扫描上限而被丢弃的文件数（PERF-01：>0 时必须向用户明示"未索引"；total = 已登记 + 此数 = 真实总数） */
  truncated: number;
}

export interface OpenRequest {
  slug: string | null;
  path: string | null;
  sec: string | null;
}

/* 应用内选择对话框的数据源（folio-fs::list_dir；UI 规范 v1.1 §8.6） */
export interface FsEntry {
  name: string;
  path: string;
}
export interface FsFile extends FsEntry {
  mtime: number;
  /** 扩展名属于 .md/.markdown/.txt（对话框文件模式按类型下拉再过滤） */
  supported: boolean;
}
export interface DirListing {
  /** 上一级；"::my-pc" 为「此电脑」哨兵（盘符根的父级） */
  parent: string | null;
  dirs: FsEntry[];
  files: FsFile[];
}

/* ── 源码自动格式化（《Folio 源码自动格式化方案》v1.0；权威实现 crates/folio-core/src/format.rs）── */
export interface FormatOptions {
  /** 行尾风格：preserve = 保持原文件 CRLF/LF */
  eol: "preserve" | "lf" | "crlf";
  /** 连续空行最多保留几条（默认 1） */
  maxBlankLines: number;
  /** `##标题` → `## 标题` */
  normalizeHeadings: boolean;
  /** `-item` / `1.item` / `- [x]done` 补空格 */
  normalizeLists: boolean;
  /** `>quote` → `> quote` */
  normalizeQuotes: boolean;
  /** 围栏语言小写 + 未闭合围栏补闭合 */
  normalizeFences: boolean;
  /** 表格单元格首尾空白清理 */
  trimTableCells: boolean;
  /** 文件末尾恰好一个换行 */
  ensureFinalNewline: boolean;
}

export interface FormatResult {
  text: string;
  changed: boolean;
  /** 变化行数（压缩空行导致行号平移时按同行位比较，仅用于「N 处更改」提示） */
  changedLines: number;
  /** 按格式化后文本重算的大纲（行号已更新） */
  outline: OutlineItem[];
  secCount: number;
  wordCount: number;
  headCount: number;
  /** 格式化后的标题（首行 "# "，与 folio-db 登记口径一致）；null = 保留原标题 */
  title: string | null;
  warnings: string[];
}

export interface HistEntry {
  docId: number;
  path: string;
  sec: number | null;
  secText: string | null;
  top: number | null;
  ratio: number | null;
  /** v1.2：同文档历史的绝对位置主坐标=小数源码行号（内存态，不进库） */
  lineFloat?: number | null;
}
