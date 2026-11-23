use serde::{Deserialize, Serialize};

/// 文档库条目（列表用，不含正文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: i64,
    /// 绝对路径（主键之一，也是深度链接 doc 参数的实际寻址方式）
    pub path: String,
    /// 深度链接里的稳定标识：文件名 slug，重名自动加数字后缀
    pub slug: String,
    pub title: String,
    pub dir: String,
    pub file_name: String,
    pub size: u64,
    /// 文件 mtime（unix 秒）
    pub mtime: i64,
    /// 正文口径字数：非空白码点数，**公式块（$$/```math）与图表块（```mermaid 含 zenuml）整块不计**
    /// （2026-11-17 需求定夺；权威实现 markdown::stats，前端 lib/wordcount.ts 同规则同 fixture 钉桩）
    pub word_count: i64,
    /// 大纲条目数（h1~h6）
    pub head_count: i64,
    /// 小节数（h2~h6），状态栏「N 节」与正文「N 个小节」同口径
    pub sec_count: i64,
    /// 文档库成员：**仅当位于已登记的库根目录之下**（由「打开文件夹…」扫描登记）。
    /// schema v3 起「打开单个文件」不再入库——那属于「最近打开」，见 `recents`。
    pub in_library: bool,
    /// 置顶（schema v2；只对库成员有意义：库列表的「置顶」分组。降级出库时自动取消）
    pub pinned: bool,
    /// 内置文档（欢迎页等，落在应用数据目录下）。不参与库成员判定，也不被「清空最近打开」清理
    #[serde(default)]
    pub builtin: bool,
}

/// 「最近打开」条目：打开历史 = 登记条目 + 打开时刻（schema v3 与 documents 解耦）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDoc {
    pub meta: DocMeta,
    /// 最近一次打开的时间（unix **秒**，与 mtime / positions.updated_at 同单位）
    pub opened_at: i64,
}

/// 清空打开历史的结果：清掉多少条历史、顺带回收多少条失去归属的登记
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentReport {
    pub cleared: i64,
    pub pruned: i64,
}

/// 打开文档：元数据 + 源文本 + 派生结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFull {
    pub meta: DocMeta,
    pub src: String,
    pub outline: Vec<OutlineItem>,
    /// 来源编码标签（utf-8 / gbk / gb18030，2026-11-20 GBK 支持）：src 恒为解码后的
    /// UTF-8 内存文本，此标签只决定「保存/另存为回写磁盘用哪套字节」。
    #[serde(default = "default_encoding")]
    pub encoding: String,
}

fn default_encoding() -> String {
    "utf-8".to_string()
}

/// 大纲条目。anchor 即 data-sec 序号（文档内自增），历史/进度锚定优先用它，文本兜底
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    /// 文档内序号，1 起
    pub sec: i64,
    pub level: i64,
    pub text: String,
    /// 源文本中的行号（0 起），编辑器定位用
    pub line: i64,
}

/// 阅读位置（对应原型 folio-pos-map 的每文档条目）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub ratio: f64,
    /// 锚定：最近标题的文本
    pub sec_text: Option<String>,
    /// 锚定：最近标题的 data-sec 序号
    pub sec: Option<i64>,
    /// 标题内偏移（px；v1.2 起与恢复式子镜像对称：scrollTop-(offsetTop-HEAD_OFFSET)）
    pub sec_off: f64,
    /// v6（滚动同步方案 §4.3）：章节内源码行偏移，恢复主坐标；-1=无值（旧行）
    #[serde(default = "no_line_off")]
    pub sec_line_off: f64,
    pub updated_at: i64,
}

/// sec_line_off 的「无值」哨兵（Default 派生取 0 会与「章节首行」歧义，构造点务必显式 -1.0）
pub fn no_line_off() -> f64 {
    -1.0
}

/// 搜索命中（块级）。scope=Library 时带文档信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub doc_id: i64,
    pub doc_path: String,
    pub doc_title: String,
    /// 所属章节标题文本；文档开头为 ""
    pub sec: String,
    pub sec_anchor: Option<i64>,
    /// 展示片段（命中词以 « » 包裹，前端替换为 <em>）
    pub snippet: String,
    /// 该块内命中次数
    pub count: i64,
    /// 是否命中在标题本身（前端把分组头渲染为可点行）
    pub is_heading: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchScope {
    /// 仅当前文档
    Current,
    /// 全部已登记条目（FTS5 圈定）：库成员 + 只出现在「最近打开」里的文件。
    /// 变体名 `Library` 是历史遗留（v3 之前两者等同），口径以本注释为准，前端标签=「全部」。
    Library,
}

impl Default for SearchScope {
    fn default() -> Self {
        SearchScope::Current
    }
}

/// 搜索请求
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    pub scope: SearchScope,
    /// scope=Current 时的文档 id
    pub doc_id: Option<i64>,
    pub limit: Option<i64>,
    /// scope=Current 且前端持有当前正文（含未保存打勾/编辑缓冲）时直传：
    /// 省一次读盘，并且搜索的是用户眼前的文本而不是磁盘旧版。
    /// 缺省 = 读盘（浏览器 mock/旧前端仍工作）。
    pub src: Option<String>,
}

/// 排版/界面偏好。fs 分字体基线；width/lh 对阅读区生效。
/// 结构级 default：带着旧版本 JSON（缺字段）升级不得整体回退默认值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,          // "dark" | "light" | "sepia"（护眼米色）
    /// 强调色 hex（如 "#2DD4BF"）；空串 = 跟随主题内置强调色。
    /// 派生的 --accent-dim/-ink/-bg 由前端 lib/accent.ts 按亮度计算，Rust 只存基色。
    pub accent: String,
    pub serif: bool,
    pub fs_serif: f64,
    pub fs_sans: f64,
    pub width: i64,             // 行宽 px
    pub lh: f64,                // 行高倍率
    pub library_root: Option<String>,
    /// 扫描硬上限（FR-1.3：默认 2000，超出截断并明示；None=默认）
    pub scan_limit: Option<usize>,
    /// 左侧面板宽度 px（拖分隔条得到；None=用 CSS 默认 266）
    pub side_width: Option<i64>,
    /// 正文字距 em（0–0.12；0=不额外加字距）
    pub letter_spacing: f64,
    /// 段落间距 em（0.6–2.0，相对正文字号）
    pub para_spacing: f64,
    /// 正文对齐："left" | "justify"（中文长文两端对齐更齐）
    pub align: String,
    /// 代码块字号 px（11–14，独立于正文——代码常想比正文小一点）
    pub code_fs: f64,
    /// 表格密度："compact" | "standard" | "loose"
    pub table_density: String,
    /// 启动时自动恢复上次文档；false = 空态启动（需求方 2026-11-18）。
    /// 旧库 JSON 缺此字段时经 struct 级 serde(default) 取 Default=true，行为不回退。
    pub restore_on_launch: bool,
    /// 段落内单个换行按换行显示（需求 2026-11-23）；false = 按 GFM/CommonMark 折叠为一个空格（默认）。
    /// 旧库 JSON 缺此字段 → false（规范口径），无需数据库迁移。
    pub soft_break_br: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // 首启默认＝浅色 + 石青（需求方 2026-11-18）；必须与 src/lib/defaults.ts 逐字段一致
        Settings {
            theme: "light".into(),
            accent: "#1B6372".into(),
            serif: true,
            fs_serif: 15.5,
            fs_sans: 14.0,
            width: 900,
            lh: 1.85,
            library_root: None,
            scan_limit: None,
            side_width: None,
            letter_spacing: 0.0,
            para_spacing: 1.0,
            align: "left".into(),
            code_fs: 12.5,
            table_density: "standard".into(),
            restore_on_launch: true,
            soft_break_br: false,
        }
    }
}

/// 打开文件夹命令的返回：扫描统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub root: String,
    pub total: usize,
    pub inserted: usize,
    pub updated: usize,
    pub removed: usize,
    pub skipped: usize,
    /// mtime+size 未变化而跳过重读重算的数量（增量扫描，NFR-4）
    pub unchanged: usize,
    /// 单库策略（schema v4）：本次「打开文件夹」替换掉的旧库根（若有）
    pub prev_root: Option<String>,
    /// 旧库根下随之出库（降级为仅最近打开）的条数
    pub prev_demoted: usize,
    /// 达到 scanLimit 上限而被丢弃的文件数（PERF-01：0 = 全部登记完；>0 时 UI 必须如实提示"未索引"）
    pub truncated: usize,
}
