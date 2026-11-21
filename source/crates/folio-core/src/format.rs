//! Markdown 源码保守格式化器（《Folio 源码自动格式化方案》v1.0 §3，2026-11-18）。
//!
//! 契约（与 markdown.rs / md.ts 同一坐标系）：
//! - 围栏认 ``` 与 ~~~（GFM 4.5，2026-11-21 第二档），开启/闭合复用 `markdown::fence_open/fence_close`
//!   （同字符、闭不短于开）；
//! - 围栏、缩进代码块（4 空格 / Tab 起头）、HTML 块、`$$` 数学块、frontmatter 内部逐字节保留；
//! - 只改结构空白与标记，不重排段落 / 不折行 / 不动链接图片 / 不重排表格列宽；
//! - 幂等：`format(format(x)) == format(x)`。
//!
//! 纯字符串函数：无 IO、无 Tauri 依赖，便于单测与属性测试。
//! 刻意保持保守：宁可不改，也不制造语义变化（`**粗体**`、`-1`、`+86`、`1.5` 等一律不动）。

use serde::{Deserialize, Serialize};

use crate::markdown::{fence_close, fence_open};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EolStyle {
    /// 保持原文件的 CRLF / LF 风格（默认）
    Preserve,
    Lf,
    Crlf,
}

impl Default for EolStyle {
    fn default() -> Self {
        EolStyle::Preserve
    }
}

/// 格式化开关。字段级 `default`：前端只传关心的项也不会整份回退。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FormatOptions {
    pub eol: EolStyle,
    /// 连续空行最多保留几条（默认 1；0 = 全部压掉，慎用）
    pub max_blank_lines: usize,
    /// `##标题` → `## 标题`（标题级别与文字不变）
    pub normalize_headings: bool,
    /// `-item` → `- item`、`1.item` → `1. item`、`- [x]done` → `- [x] done`
    pub normalize_lists: bool,
    /// `>quote` → `> quote`（含嵌套 `>>x` → `>> x`）
    pub normalize_quotes: bool,
    /// 围栏语言名转小写；未闭合围栏在文末补一个闭合围栏
    pub normalize_fences: bool,
    /// 表格单元格首尾空白清理（不重排列宽、不改对齐标记）
    pub trim_table_cells: bool,
    /// 文件末尾恰好一个换行
    pub ensure_final_newline: bool,
}

impl Default for FormatOptions {
    fn default() -> Self {
        Self {
            eol: EolStyle::Preserve,
            max_blank_lines: 1,
            normalize_headings: true,
            normalize_lists: true,
            normalize_quotes: true,
            normalize_fences: true,
            trim_table_cells: true,
            ensure_final_newline: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub text: String,
    pub changed: bool,
    /// 与原文同行位比较后不同的行数（压缩空行导致行号平移时按最大长度比较，仅用于提示"N 处更改"）
    pub changed_lines: usize,
    pub warnings: Vec<String>,
}

/// 缩进前缀（空格 / 制表符）与其余部分。索引只落在 ASCII 上，字节切片安全。
fn split_indent(line: &str) -> (usize, &str) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    (i, &line[i..])
}

/// 行首缩进的视觉宽度（Tab 按 4 列制表位；只用于判定缩进代码块，不参与输出）。
fn indent_width(line: &str) -> usize {
    let mut w = 0usize;
    for c in line.chars() {
        match c {
            ' ' => w += 1,
            '\t' => w += 4 - (w % 4),
            _ => break,
        }
    }
    w
}

/// 与 md.ts::MATH_FENCE_RE 同口径：整行只有 `$$` 才算数学块界行。
fn is_math_fence(line: &str) -> bool {
    line.trim() == "$$"
}

/// 与 md.ts::HTML_BLOCK_RE 近似：≤3 空格缩进的 `<!--` 或 `<tag…` / `</tag>`。
/// 块内不格式化（保守；Rust 侧大纲口径与 HTML 无关，跳过不会造成坐标错位）。
fn is_html_block_start(line: &str) -> bool {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && i < 4 && b[i] == b' ' {
        i += 1;
    }
    if i > 3 || i >= b.len() || b[i] != b'<' {
        return false;
    }
    if line[i..].starts_with("<!--") {
        return true;
    }
    let mut j = i + 1;
    if j < b.len() && b[j] == b'/' {
        j += 1;
    }
    if j >= b.len() || !b[j].is_ascii_alphabetic() {
        return false;
    }
    j += 1;
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'-') {
        j += 1;
    }
    j >= b.len() || matches!(b[j], b' ' | b'\t' | b'/' | b'>' | b'\n' | b'\r')
}

/// 主题分隔线（`---` / `***` / `___`）：不是列表标记，不补空格。
fn is_thematic_break(s: &str) -> bool {
    let mut ch: Option<char> = None;
    let mut count = 0usize;
    for c in s.trim_end().chars() {
        if c == ' ' || c == '\t' {
            continue;
        }
        match ch {
            None => {
                if c == '-' || c == '*' || c == '_' {
                    ch = Some(c);
                    count = 1;
                } else {
                    return false;
                }
            }
            Some(prev) => {
                if c != prev {
                    return false;
                }
                count += 1;
            }
        }
    }
    count >= 3
}

/// 若首行是 frontmatter 的 `---`，返回闭合界行下标。
/// 收紧判定（评审 P3-5）：块内必须至少有一行像 YAML 键值对（非空、非注释、含 `:`），
/// 且闭合界行须在前 100 行内——避免把「主题分隔线 → 正文 → 主题分隔线」误当 frontmatter
/// 整块冻结（那会悄悄跳过正文格式化）。找不到可信闭合就按普通主题分隔线处理。
fn frontmatter_end(rows: &[&str]) -> Option<usize> {
    if !rows.first().map(|r| r.trim() == "---").unwrap_or(false) {
        return None;
    }
    let limit = rows.len().min(100);
    for i in 1..limit {
        let t = rows[i].trim();
        if t == "---" || t == "..." {
            let looks_yaml = rows[1..i].iter().any(|r| {
                let s = r.trim_start();
                !s.is_empty() && !s.starts_with('#') && s.contains(':')
            });
            return if looks_yaml { Some(i) } else { None };
        }
    }
    None
}

/// ATX 标题：`##标题` → `## 标题`。只补一个空格，标题级别与文字不动。
/// 排除 `#!`（shebang）；`#话题` 这类歧义按方案 §3.1 第 1 条归为标题修正。
fn normalize_heading_line(line: &str) -> String {
    let (ind, rest) = split_indent(line);
    if rest.is_empty() {
        return line.to_string();
    }
    let hashes = rest.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return line.to_string();
    }
    let after = &rest[hashes..];
    let Some(first) = after.chars().next() else {
        return line.to_string(); // 裸 `#` 保持原样
    };
    if first == ' ' || first == '\t' || first == '!' {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 1);
    out.push_str(&line[..ind]);
    out.push_str(&rest[..hashes]);
    out.push(' ');
    out.push_str(after);
    out
}

/// 无序列表 `-item` / `+item` → `- item`。
/// 刻意的保守边界：`*` 开头整行不动（`*斜体*` 风险最高）；`-1` / `+86`（数字开头）不动；
/// 正文既无空白也不以中文开头（如 `-foo` 单词）不动——宁可漏改，也不把正文变成列表。
fn normalize_list_line(line: &str) -> String {
    let (ind, rest) = split_indent(line);
    let b = rest.as_bytes();
    if b.len() < 2 {
        return line.to_string();
    }
    let m = b[0];
    if m == b'-' || m == b'*' || m == b'+' {
        // `*` 行首与强调语法正面冲突：只有"整行再无别的 *"才当列表（`*item one` 修，`*斜体*` 不动）
        if m == b'*' && b[1..].contains(&b'*') {
            return line.to_string();
        }
        let next = b[1];
        if next == b' ' || next == b'\t' || next == m {
            return line.to_string();
        }
        if next.is_ascii_digit() {
            return line.to_string();
        }
        if is_thematic_break(rest) {
            return line.to_string();
        }
        let body = &rest[1..];
        let first = body.chars().next().unwrap_or(' ');
        if !body.chars().any(|c| c == ' ' || c == '\t') && !is_cjk(first) {
            return line.to_string();
        }
        let mut out = String::with_capacity(line.len() + 1);
        out.push_str(&line[..ind]);
        out.push_str(&rest[..1]);
        out.push(' ');
        out.push_str(body);
        return out;
    }
    // 有序列表：1.item / 1)item → 1. item / 1) item
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 || b.len() <= digits + 1 {
        return line.to_string();
    }
    let sep = b[digits];
    if sep != b'.' && sep != b')' {
        return line.to_string();
    }
    let next = b[digits + 1];
    if next == b' ' || next == b'\t' {
        return line.to_string();
    }
    if sep == b'.' && next.is_ascii_digit() {
        return line.to_string(); // 1.5 小数，不是列表
    }
    let body = &rest[digits + 1..];
    let mut out = String::with_capacity(line.len() + 1);
    out.push_str(&line[..ind]);
    out.push_str(&rest[..digits + 1]);
    out.push(' ');
    out.push_str(body);
    out
}

fn is_cjk(c: char) -> bool {
    ('\u{3000}'..='\u{303f}').contains(&c) || ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// 任务清单：`- [x]done` → `- [x] done`（状态与文字不动）。
/// 拆分口径与 md.ts::afterListMarker 一致：缩进 + 列表标记 + 空白 + `[ ]/[x]/[X]`。
fn normalize_task_line(line: &str) -> String {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    if i >= b.len() {
        return line.to_string();
    }
    let mut j = i;
    let c0 = b[j];
    if c0 == b'-' || c0 == b'*' || c0 == b'+' {
        j += 1;
    } else if c0.is_ascii_digit() {
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j >= b.len() || (b[j] != b'.' && b[j] != b')') {
            return line.to_string();
        }
        j += 1;
    } else {
        return line.to_string();
    }
    if j >= b.len() || (b[j] != b' ' && b[j] != b'\t') {
        return line.to_string();
    }
    while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
        j += 1;
    }
    if j + 2 >= b.len() {
        return line.to_string();
    }
    if b[j] != b'[' || b[j + 2] != b']' || !matches!(b[j + 1], b' ' | b'x' | b'X') {
        return line.to_string();
    }
    let after = j + 3;
    if after >= b.len() || b[after] == b' ' || b[after] == b'\t' {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 1);
    out.push_str(&line[..after]);
    out.push(' ');
    out.push_str(&line[after..]);
    out
}

/// 引用块：`>quote` → `> quote`；嵌套 `>>x` → `>> x`、`> >x` → `> > x`。
/// 已有空白（含多空格 / 制表符）一律保留，只补缺失的那一个。
fn normalize_quote_line(line: &str) -> String {
    let (ind, rest) = split_indent(line);
    if !rest.starts_with('>') {
        return line.to_string();
    }
    let s = rest.as_bytes();
    let mut out = String::with_capacity(rest.len() + 2);
    let mut i = 0usize;
    loop {
        if i >= s.len() || s[i] != b'>' {
            break;
        }
        out.push('>');
        i += 1;
        let sp0 = i;
        while i < s.len() && (s[i] == b' ' || s[i] == b'\t') {
            i += 1;
        }
        if i < s.len() && s[i] == b'>' {
            out.push_str(&rest[sp0..i]); // 保留标记间原有空白，继续下一层
            continue;
        }
        if i < s.len() && i == sp0 {
            out.push(' ');
        } else {
            out.push_str(&rest[sp0..i]);
        }
        break;
    }
    out.push_str(&rest[i..]);
    let mut r = String::with_capacity(ind + out.len());
    r.push_str(&line[..ind]);
    r.push_str(&out);
    r
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// 表格行拆分（GFM）：代码段里的 `|`、反斜杠转义 `\|` 都不算分隔符。
/// 返回（缩进字节数, 首竖线, 单元格, 尾竖线）。末尾转义的 `\|` 不会被误判为尾竖线。
fn split_table_cells(line: &str) -> Option<(usize, bool, Vec<String>, bool)> {
    let (ind, body) = split_indent(line);
    if !body.contains('|') {
        return None;
    }
    let b = body.as_bytes();
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' && i + 1 < b.len() {
            let end = (i + 1 + utf8_len(b[i + 1])).min(b.len());
            cur.push_str(&body[i..end]);
            i = end;
            continue;
        }
        if c == b'`' {
            let mut run = 0usize;
            while i + run < b.len() && b[i + run] == b'`' {
                run += 1;
            }
            let token = &body[i..i + run];
            let mut j = i + run;
            let mut hit: Option<usize> = None;
            while let Some(p) = body[j..].find(token) {
                let abs = j + p;
                if abs + run < b.len() && b[abs + run] == b'`' {
                    j = abs + run;
                    continue;
                }
                hit = Some(abs);
                break;
            }
            match hit {
                Some(h) => {
                    cur.push_str(&body[i..h + run]);
                    i = h + run;
                }
                None => {
                    cur.push_str(token);
                    i += run;
                }
            }
            continue;
        }
        if c == b'|' {
            cells.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        let end = (i + utf8_len(c)).min(b.len());
        cur.push_str(&body[i..end]);
        i = end;
    }
    cells.push(cur);

    let lead = body.starts_with('|') && cells.first().map(|c| c.trim().is_empty()).unwrap_or(false);
    let trail = body.ends_with('|') && cells.last().map(|c| c.trim().is_empty()).unwrap_or(false);
    if lead {
        cells.remove(0);
    }
    if trail && !cells.is_empty() {
        cells.pop();
    }
    if cells.is_empty() {
        return None;
    }
    let cells: Vec<String> = cells.into_iter().map(|c| c.trim().to_string()).collect();
    Some((ind, lead, cells, trail))
}

/// 表格行：只清单元格首尾空白，重建成 `| a | b |` 的规范间距（列宽与对齐标记不动）。
fn normalize_table_row(line: &str) -> String {
    let Some((ind, lead, cells, trail)) = split_table_cells(line) else {
        return line.to_string();
    };
    let mut out = String::with_capacity(line.len() + 4);
    out.push_str(&line[..ind]);
    if lead {
        out.push('|');
    }
    for (k, c) in cells.iter().enumerate() {
        if k > 0 || lead {
            out.push(' ');
        }
        out.push_str(c);
        if k + 1 < cells.len() || trail {
            out.push_str(" |");
        }
    }
    out
}

/// 表格分隔行判定：每格只含 `-` 与可选的两端 `:`（`---` / `:---:` / `---:`）。
fn is_table_delim(line: &str) -> bool {
    if !line.contains('|') {
        return false;
    }
    let Some((_, _, cells, _)) = split_table_cells(line) else {
        return false;
    };
    if cells.is_empty() {
        return false;
    }
    cells.iter().all(|c| {
        let t = c.trim_start_matches(':').trim_end_matches(':');
        !t.is_empty() && t.chars().all(|ch| ch == '-')
    })
}

/// 开围栏行的语言名转小写（只动第一个词；meta 与缩进原样保留）。
/// 开启行规范化：info 首词小写（Js → js），标记长度/缩进原样保留。
/// 2026-11-21 第二档：` 与 ~ 两类标记都支持（首字节决定字符）。
fn normalize_fence_open(line: &str) -> String {
    let (ind, rest) = split_indent(line);
    let marker = rest.as_bytes().first().copied();
    let is_tick = matches!(marker, Some(b'`') | Some(b'~'));
    let ticks = if is_tick {
        rest.bytes().take_while(|b| *b == marker.unwrap()).count()
    } else {
        0
    };
    if ticks < 3 {
        return line.to_string();
    }
    let after = &rest[ticks..];
    let ws = after.len() - after.trim_start_matches(|c| c == ' ' || c == '\t').len();
    let body = &after[ws..];
    if body.is_empty() {
        return line.to_string();
    }
    let lang_end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
    let lang = &body[..lang_end];
    let lower = lang.to_lowercase();
    if lower == lang {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    out.push_str(&line[..ind]);
    out.push_str(&rest[..ticks]);
    out.push_str(&after[..ws]);
    out.push_str(&lower);
    out.push_str(&body[lang_end..]);
    out
}

/// 变化行数（评审 P2-1）：同行位比较会把「前面删一行」误报成后面全部改变。
/// 改用带重同步窗口的贪心行 diff：删/插按实际行数计，改动按 1 处计；
/// 窗口 64 足以吞掉空行压缩、围栏补齐这类连续块。仅为 toast 提示「N 处更改」服务，
/// 不追求 LCS 最优编辑距离，但不会再把一处空行报成几百处。
const DIFF_WINDOW: usize = 64;

fn count_changed_lines(orig: &[&str], out: &[String]) -> usize {
    let mut i = 0usize;
    let mut j = 0usize;
    let mut changed = 0usize;
    while i < orig.len() && j < out.len() {
        if orig[i] == out[j] {
            i += 1;
            j += 1;
            continue;
        }
        // 在窗口内找下一处可对齐的行：orig 侧跳过的算删除，out 侧跳过的算插入
        let remaining = (orig.len() - i).max(out.len() - j);
        let w = DIFF_WINDOW.min(remaining);
        let mut sync: Option<(usize, usize)> = None;
        let mut k = 1usize;
        while k <= w {
            if i + k < orig.len() && orig[i + k] == out[j] {
                sync = Some((k, 0));
                break;
            }
            if j + k < out.len() && orig[i] == out[j + k] {
                sync = Some((0, k));
                break;
            }
            k += 1;
        }
        match sync {
            Some((del, ins)) => {
                changed += del + ins;
                i += del;
                j += ins;
            }
            None => {
                changed += 1;
                i += 1;
                j += 1;
            }
        }
    }
    changed + (orig.len() - i) + (out.len() - j)
}

/// 保守格式化入口：纯函数，返回新文本与变化统计。
pub fn format_markdown(src: &str, opt: &FormatOptions) -> FormatResult {
    let mut warnings: Vec<String> = Vec::new();
    if src.is_empty() {
        return FormatResult::default();
    }
    let eol = match opt.eol {
        EolStyle::Preserve => {
            if src.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            }
        }
        EolStyle::Lf => "\n",
        EolStyle::Crlf => "\r\n",
    };
    // 末尾换行统一交给 ensure_final_newline 处理；这里先剥掉，顺带消掉尾部空白行。
    let body = src.trim_end_matches(|c| c == '\n' || c == '\r');
    let rows: Vec<&str> = if body.is_empty() {
        Vec::new()
    } else {
        body.split('\n')
            .map(|r| r.strip_suffix('\r').unwrap_or(r))
            .collect()
    };
    if rows.is_empty() {
        let text = if opt.ensure_final_newline { eol.to_string() } else { String::new() };
        let changed = text != src;
        return FormatResult {
            changed_lines: usize::from(changed),
            text,
            changed,
            warnings,
        };
    }

    let n = rows.len();
    let fm_end = frontmatter_end(&rows);
    let mut out: Vec<String> = Vec::with_capacity(n + 2);
    let mut i = 0usize;
    let mut in_fence = false;
    let mut in_math = false;
    let mut in_html = false;
    // 缩进代码块（评审 P1-1）：4 空格 / Tab 起头的内容逐字节保留，直到出现非缩进行
    let mut in_indented = false;
    // 当前围栏的开围栏缩进、标记字符与长度（评审 P1-2 + 2026-11-21 第二档：` 与 ~ 两类，补闭合同字符同长）
    let mut fence_indent = String::new();
    let mut fence_char = '`';
    let mut fence_ticks = 3usize;
    let mut blank_run = 0usize;

    while i < n {
        let raw = rows[i];

        // frontmatter 原样保留（首行 --- 且块内像 YAML、找得到闭合界行才算）
        if let Some(end) = fm_end {
            if i <= end {
                out.push(raw.to_string());
                i += 1;
                continue;
            }
        }

        // 缩进代码块内部：空行与继续缩进的行原样保留（标准 Markdown 里它们是代码内容）
        if in_indented {
            if raw.trim().is_empty() || indent_width(raw) >= 4 {
                out.push(raw.to_string());
                i += 1;
                continue;
            }
            in_indented = false; // 缩进结束，本行回到常规流程
        }

        // 围栏内部：逐字节保留，只认同字符且不短于开栏的闭合围栏
        if in_fence {
            out.push(raw.to_string());
            if fence_close(raw, (fence_char, fence_ticks)) {
                in_fence = false;
            }
            i += 1;
            continue;
        }
        // $$ 数学块内部：原样保留（Rust 大纲会把块内 "# " 计标题，但格式化不改这些行）
        if in_math {
            out.push(raw.to_string());
            if is_math_fence(raw) {
                in_math = false;
            }
            i += 1;
            continue;
        }
        // HTML 块内部：原样保留，空行结束块
        if in_html {
            if raw.trim().is_empty() {
                in_html = false;
                blank_run = 1;
                out.push(String::new());
            } else {
                out.push(raw.to_string());
            }
            i += 1;
            continue;
        }

        // 缩进代码块入口：整行 ≥4 列缩进（Tab 按 4 列）且非空 → 原样保留。
        // 放在围栏判定之前：标准 Markdown 里「4 空格 + ```」是缩进代码内容，不是围栏。
        if !raw.trim().is_empty() && indent_width(raw) >= 4 {
            out.push(raw.to_string());
            in_indented = true;
            blank_run = 0;
            i += 1;
            continue;
        }

        if let Some((c, n)) = fence_open(raw) {
            let (fi, _) = split_indent(raw);
            fence_indent = raw[..fi].to_string();
            fence_char = c;
            fence_ticks = n;
            out.push(if opt.normalize_fences {
                normalize_fence_open(raw)
            } else {
                raw.to_string()
            });
            in_fence = true;
            blank_run = 0;
            i += 1;
            continue;
        }
        if is_math_fence(raw) {
            out.push(raw.to_string());
            in_math = true;
            blank_run = 0;
            i += 1;
            continue;
        }
        if is_html_block_start(raw) {
            out.push(raw.to_string());
            in_html = true;
            blank_run = 0;
            i += 1;
            continue;
        }

        // GFM 表格块：表头行 + 分隔行 + 连续含 | 的行
        if opt.trim_table_cells && i + 1 < n && raw.contains('|') && is_table_delim(rows[i + 1]) {
            out.push(normalize_table_row(raw));
            out.push(normalize_table_row(rows[i + 1]));
            i += 2;
            while i < n && !rows[i].trim().is_empty() && rows[i].contains('|') {
                out.push(normalize_table_row(rows[i]));
                i += 1;
            }
            blank_run = 0;
            continue;
        }

        if raw.trim().is_empty() {
            blank_run += 1;
            if blank_run <= opt.max_blank_lines {
                out.push(String::new());
            }
            i += 1;
            continue;
        }

        blank_run = 0;
        let mut line = raw.to_string();
        if opt.normalize_quotes {
            line = normalize_quote_line(&line);
        }
        if opt.normalize_headings {
            line = normalize_heading_line(&line);
        }
        if opt.normalize_lists {
            line = normalize_list_line(&line);
            line = normalize_task_line(&line);
        }
        out.push(line);
        i += 1;
    }

    if in_fence && opt.normalize_fences {
        // 同缩进 + 同字符 + 同长度：CommonMark 要求闭合围栏不短于开启围栏，
        // 否则标准渲染器不会把这里当闭合（评审 P1-2）
        out.push(format!("{}{}", fence_indent, fence_char.to_string().repeat(fence_ticks)));
        warnings.push("已补全未闭合的代码围栏".to_string());
    }

    let mut text = out.join(eol);
    if opt.ensure_final_newline && !text.is_empty() {
        text.push_str(eol);
    }
    let changed = text != src;
    let changed_lines = if changed {
        count_changed_lines(&rows, &out).max(1)
    } else {
        0
    };
    FormatResult {
        text,
        changed,
        changed_lines,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(src: &str) -> String {
        format_markdown(src, &FormatOptions::default()).text
    }

    #[test]
    fn heading_gets_space() {
        assert_eq!(fmt("##标题\n"), "## 标题\n");
        assert_eq!(fmt("######六\n"), "###### 六\n");
        assert_eq!(fmt("#######七级不算\n"), "#######七级不算\n");
        assert_eq!(fmt("## 已规范\n"), "## 已规范\n");
        assert_eq!(fmt("#\n"), "#\n", "裸 # 不动");
    }

    #[test]
    fn list_and_task_get_space() {
        assert_eq!(fmt("-item one\n"), "- item one\n");
        assert_eq!(fmt("-项目一\n"), "- 项目一\n");
        assert_eq!(fmt("- [x]done\n"), "- [x] done\n");
        assert_eq!(fmt("- [ ]\n"), "- [ ]\n");
        assert_eq!(fmt("1.item\n"), "1. item\n");
        assert_eq!(fmt("2)item\n"), "2) item\n");
        assert_eq!(fmt("  1.item\n"), "  1. item\n");
    }

    #[test]
    fn list_negatives_untouched() {
        // 宁可漏改，也不把正文变成列表 / 把强调拆坏
        for s in ["**粗体**\n", "*斜体*\n", "-1\n", "+86\n", "1.5 倍\n", "---\n", "- - -\n"] {
            assert_eq!(fmt(s), s, "不该改：{s}");
        }
    }

    #[test]
    fn star_list_without_emphasis_is_normalized() {
        assert_eq!(fmt("*item one\n"), "* item one\n");
        assert_eq!(fmt("*斜体* 后面还有字\n"), "*斜体* 后面还有字\n");
    }

    #[test]
    fn quote_gets_space_but_keeps_existing() {
        assert_eq!(fmt(">quote\n"), "> quote\n");
        assert_eq!(fmt(">>quote\n"), ">> quote\n");
        assert_eq!(fmt("> >x\n"), "> > x\n");
        assert_eq!(fmt(">   缩进保留\n"), ">   缩进保留\n");
    }

    #[test]
    fn fence_lang_lowercased_and_inner_bytes_kept() {
        let src = "```JS\n##标题\n- [ ]x\n  const x = 1;  \n```\n";
        let want = "```js\n##标题\n- [ ]x\n  const x = 1;  \n```\n";
        assert_eq!(fmt(src), want);
    }

    #[test]
    fn unclosed_fence_closed_with_warning() {
        let r = format_markdown("```js\nlet x = 1;\n", &FormatOptions::default());
        assert_eq!(r.text, "```js\nlet x = 1;\n```\n");
        assert_eq!(r.warnings.len(), 1);
        assert!(r.changed);
    }

    #[test]
    fn blank_lines_collapse_outside_fences() {
        assert_eq!(fmt("a\n\n\n\nb\n"), "a\n\nb\n");
        assert_eq!(fmt("```\na\n\n\n\nb\n```\n"), "```\na\n\n\n\nb\n```\n");
    }

    #[test]
    fn final_newline_exactly_one() {
        assert_eq!(fmt("a"), "a\n");
        assert_eq!(fmt("a\n\n\n"), "a\n");
        assert_eq!(fmt("a\n"), "a\n");
    }

    #[test]
    fn crlf_style_preserved() {
        assert_eq!(fmt("##标题\r\n\r\n\r\n\r\nx\r\n"), "## 标题\r\n\r\nx\r\n");
    }

    #[test]
    fn lf_style_preserved() {
        assert_eq!(fmt("##标题\n\n\n\nx\n"), "## 标题\n\nx\n");
    }

    #[test]
    fn table_cells_trimmed_but_alignment_kept() {
        let src = "|  a  |  b |\n| :--- | ---: |\n|  1  |  2 |\n";
        let want = "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n";
        assert_eq!(fmt(src), want);
    }

    #[test]
    fn table_code_span_pipe_not_split() {
        let src = "| a | b |\n| --- | --- |\n| `x \\| y` | z |\n";
        let out = fmt(src);
        assert!(out.contains("`x \\| y`"), "{out}");
        assert!(out.contains("| z |"), "{out}");
    }

    #[test]
    fn math_and_frontmatter_untouched() {
        let math = "$$\n##标题\n\n\n\n$$\n";
        assert_eq!(fmt(math), math, "$$ 块内不动");
        let fm = "---\ntitle:  x\n\n\n\n---\n##标题\n";
        assert_eq!(fmt(fm), "---\ntitle:  x\n\n\n\n---\n## 标题\n");
    }

    #[test]
    fn html_block_untouched() {
        // 块内（直到首个空行）逐字节保留；空行之后的连续空行按普通规则压缩
        let src = "<div>\n##标题\n\n</div>\n";
        assert_eq!(fmt(src), src);
        assert_eq!(fmt("<div>\n##标题\n\n\n</div>\n"), "<div>\n##标题\n\n</div>\n");
    }

    #[test]
    fn already_formatted_doc_is_unchanged() {
        let src = "# 标题\n\n正文。\n\n- [ ] 任务\n\n[链接](https://example.com)\n\n```js\nconst x = 1;\n```\n";
        let r = format_markdown(src, &FormatOptions::default());
        assert!(!r.changed, "{}", r.text);
        assert_eq!(r.text, src);
    }

    #[test]
    fn idempotent() {
        let inputs = [
            "##标题\n-item one\n- [x]done\n>quote\n\n\n\n",
            "|  a  |  b |\n| --- | --- |\n| 1 | 2 |\n",
            "```JS\n##标题\n\n\n```\n",
            "---\na: 1\n\n\n---\n## x\n",
        ];
        for src in inputs {
            let once = fmt(src);
            let twice = fmt(&once);
            assert_eq!(once, twice, "幂等失败：{src:?}");
        }
    }

    #[test]
    fn semantic_protection() {
        // 标题文字、任务状态、链接 URL、代码块字节在格式化前后一致
        let src = "# 标题\n\n- [x] 已完成\n- [ ] 未完成\n\n[链接](https://example.com/a?b=1)\n\n```rust\nfn main() { println!(\"{}\", 1); }\n```\n";
        let out = fmt(src);
        assert_eq!(out, src);
        assert_eq!(crate::markdown::headings(&out).len(), 1);
        assert_eq!(crate::markdown::headings(&out)[0].text, "标题");
        assert_eq!(out.matches("- [x]").count(), 1);
        assert_eq!(out.matches("- [ ]").count(), 1);
        assert!(out.contains("https://example.com/a?b=1"));
        assert!(out.contains("fn main() { println!(\"{}\", 1); }"));
    }

    #[test]
    fn changed_lines_reported() {
        let r = format_markdown("##标题\n", &FormatOptions::default());
        assert!(r.changed);
        assert_eq!(r.changed_lines, 1);
    }

    #[test]
    fn changed_lines_not_inflated_by_blank_removal() {
        // 评审 P2-1：删一处空行不得把后面所有行都算成"更改"
        let r = format_markdown("a\n\n\nb\nc\nd\n", &FormatOptions::default());
        assert_eq!(r.text, "a\n\nb\nc\nd\n");
        assert_eq!(r.changed_lines, 1);
    }

    #[test]
    fn indented_code_block_untouched() {
        // 评审 P1-1：4 空格缩进是标准 Markdown 代码块，逐字节保留
        let src = "    ##标题\n    -item one\n    >quote\n";
        assert_eq!(fmt(src), src);
        // 缩进块结束后的正常标题仍要格式化
        assert_eq!(fmt("    ##标题\n\n##标题\n"), "    ##标题\n\n## 标题\n");
    }

    #[test]
    fn tab_indented_code_untouched() {
        let src = "\t##标题\n\t-item\n";
        assert_eq!(fmt(src), src);
    }

    #[test]
    fn unclosed_fence_closer_matches_length_and_indent() {
        // 评审 P1-2：闭合围栏必须不短于开启围栏，缩进也要一致
        let r = format_markdown("````js\ncode\n", &FormatOptions::default());
        assert_eq!(r.text, "````js\ncode\n````\n");
        let r2 = format_markdown("  ````JS\ncode\n", &FormatOptions::default());
        assert_eq!(r2.text, "  ````js\ncode\n  ````\n");
    }

    #[test]
    fn double_thematic_break_is_not_frontmatter() {
        // 评审 P3-5：首尾 --- 之间没有 YAML 键值对时，只是主题分隔线，正文照常格式化
        assert_eq!(fmt("---\n\n##标题\n\n---\n"), "---\n\n## 标题\n\n---\n");
    }

    #[test]
    fn empty_and_whitespace_only() {
        assert_eq!(fmt(""), "");
        assert_eq!(fmt("\n\n\n"), "\n");
    }

    #[test]
    fn options_can_disable_rules() {
        let opt = FormatOptions {
            normalize_headings: false,
            normalize_lists: false,
            normalize_quotes: false,
            normalize_fences: false,
            ..FormatOptions::default()
        };
        let src = "##标题\n-item\n>quote\n\n\n\n```JS\nx\n";
        let r = format_markdown(src, &opt);
        assert!(r.text.contains("##标题"));
        assert!(r.text.contains("\n-item"));
        assert!(r.text.contains("\n>quote"));
        assert!(r.text.ends_with("```JS\nx\n"), "不补闭合围栏：{}", r.text);
        assert!(!r.text.contains("\n\n\n"), "空行压缩不受这些开关影响");
    }

    #[test]
    fn eol_style_override() {
        let mut opt = FormatOptions { eol: EolStyle::Crlf, ..FormatOptions::default() };
        assert_eq!(format_markdown("a\nb\n", &opt).text, "a\r\nb\r\n");
        opt.eol = EolStyle::Lf;
        assert_eq!(format_markdown("a\r\nb\r\n", &opt).text, "a\nb\n");
    }
}