//! Markdown 的纯函数工具：标题解析、统计口径、slug、任务清单回写。
//! 重要约定（评审 v2·N3 的教训）：**凡是要和 DOM 渲染结果对序号的解析，
//! 必须与渲染器使用同一套围栏状态机**——本模块就是唯一实现。

use std::collections::HashSet;

/// 解析出的标题（sec 自 1 起，与前端 data-sec 对齐）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub sec: i64,
    pub level: i64,
    pub text: String,
    /// 源文本行号，0 起
    pub line: i64,
}

/// 输入预处理（CommonMark 0.1「lines」+ 2.1「NUL」，2026-11-21 P2）：
/// NUL→U+FFFD；裸 CR 与 CRLF 统一按 LF 切行——读取侧扫描器（line_kinds/headings/prose_chars）
/// 一律先过这里，两侧（↔ md.ts splitSrcLines）同口径。写回侧（toggle_task）不用它拼文件，
/// 用 split_lines_cr 保留原始行尾字节。
pub(crate) fn normalize(src: &str) -> String {
    let mut s = String::with_capacity(src.len());
    let b = src.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'\r' => {
                s.push('\n');
                i += if b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            }
            b'\0' => {
                s.push('\u{FFFD}');
                i += 1;
            }
            _ => {
                let start = i;
                while i < b.len() && b[i] != b'\r' && b[i] != b'\0' {
                    i += 1;
                }
                s.push_str(&src[start..i]);
            }
        }
    }
    s
}

/// 按 \r\n | \n | \r 切行，返回 (内容, 终止符)；末行无终止符则终止符为空串。
/// 行数与 normalize(src).lines() 逐一对位（toggle_task 用原终止符重建，保字节不动）。
fn split_lines_cr(src: &str) -> Vec<(&str, &'static str)> {
    let mut out = Vec::new();
    let b = src.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\n' {
            out.push((&src[start..i], "\n"));
            i += 1;
            start = i;
        } else if b[i] == b'\r' {
            let term = if b.get(i + 1) == Some(&b'\n') { "\r\n" } else { "\r" };
            out.push((&src[start..i], term));
            i += term.len();
            start = i;
        } else {
            i += 1;
        }
    }
    if start < src.len() {
        out.push((&src[start..], ""));
    }
    out
}

/// 行首缩进列（Tab 按 4 列制表位推进，CommonMark 2.2）；超过 8 直接返回大值不必精确。
pub(crate) fn indent_col(line: &str) -> usize {
    let mut col = 0usize;
    for c in line.chars() {
        match c {
            ' ' => col += 1,
            '\t' => col += 4 - (col % 4),
            _ => break,
        }
        if col >= 8 {
            return col;
        }
    }
    col
}

/// 围栏开启行（GFM 4.5，2026-11-21 第二档与 md.ts::fenceOpen 同口径）：
/// 行首 ≥3 个同一 ` 或 ~；返回 (字符, 长度)。缩进刻意不设上限（沿用旧口径）——
/// 列表项内缩进围栏是存量文档的常见写法，收紧会拆坏既有配对；CommonMark 的 ≤3 列细则
/// 由此让位于兼容性（记录于《Folio-GFM语法升级方案》）。info 首词由 fence_info 取。
pub(crate) fn fence_open(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    if n >= 3 {
        Some((c, n))
    } else {
        None
    }
}

/// 围栏闭合行：同字符、长度 ≥ 开启长度、其后仅空白（md.ts::fenceClose 同口径；缩进不设上限同上）。
pub(crate) fn fence_close(line: &str, open: (char, usize)) -> bool {
    let Some((c, n)) = fence_open(line) else { return false };
    if c != open.0 || n < open.1 {
        return false;
    }
    line.trim_start().chars().skip(n).all(|x| x == ' ' || x == '\t')
}

/// info string 首个词 = 语言（小写化后交给 lang 判定；md.ts classifyCodeLang 同口径取词）。
pub(crate) fn fence_info(line: &str) -> String {
    let t = line.trim_start();
    let n = t.chars().take_while(|&c| c == '`' || c == '~').count();
    t.chars().skip(n).collect::<String>()
        .trim()
        .split([' ', '\t'])
        .next()
        .unwrap_or("")
        .to_string()
}

/// 行种类（大纲/勾选/字数三条扫描共用的判定核；md.ts 块层按同语义分支）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Blank,
    /// ``` / ~~~ 开启行
    FenceOpen,
    /// 闭合行
    FenceClose,
    /// 围栏内部
    FenceIn,
    /// ATX 标题（≤3 列）
    Head,
    /// Setext 下划线行（上承段落；标题实体落在段落首行）
    Setext(u8),
    /// 分隔线（≥3 个同字符，允许字符间空白）
    Hr,
    /// 列表项行（<4 列恒认，≥4 列见 Code 分支说明）
    List,
    /// 引用块行
    Quote,
    /// 顶层缩进代码（≥4 列且上一非空行既非段落也非列表项；或列表内容列 ≥6）
    Code,
    /// 段落（含懒延续：≥4 列但上承段落）
    Para,
    /// 其他（HTML 行、表格分隔、定义行等——不参与标题/任务识别，仅闭合段落）
    Other,
}

/// 全文逐行分类：围栏配对 + 缩进代码/懒延续/Setext 的共用状态机。
/// 与 md.ts 块层的分支顺序互为镜像，改一侧必须双跑（tests/md.test.ts ↔ 本模块 tests）。
pub(crate) fn line_kinds(src: &str) -> Vec<Kind> {
    let norm = normalize(src); // P2：裸 CR 分行 + NUL 替换（↔ md.ts lineKinds 的 splitSrcLines）
    let lines: Vec<&str> = norm.lines().collect();
    // YAML front matter（GitHub/Jekyll 非 GFM 扩展，2026-11-22）：首行恰为 `---` 且后随
    // `---`/`...` 收口 → 该区整体按 Blank 处理（不产标题/任务/Setext，也不把状态带进正文）。
    let fm_end = front_matter_end(&lines);
    let mut out: Vec<Kind> = vec![Kind::Blank; lines.len()];
    let mut fence: Option<(char, usize)> = None;
    let mut prev: Kind = Kind::Blank; // 上一非空行的种类
    let mut adj_par = false;          // 紧邻上一行是段落正文（空行即复位——Setext 必须贴着段落）
    let start_idx = fm_end.map_or(0, |e| e + 1);
    for idx in start_idx..lines.len() {
        let raw = lines[idx];
        let k = match fence {
            Some(open) => {
                if fence_close(raw, open) {
                    fence = None;
                    Kind::FenceClose
                } else {
                    Kind::FenceIn
                }
            }
            None => {
                if raw.trim().is_empty() {
                    Kind::Blank
                } else if prev == Kind::Code && indent_col(raw) >= 4 {
                    // 缩进代码运行中：``` / ~~~ 只是代码内容，不开围栏
                    Kind::Code
                } else if fence_open(raw).is_some() {
                    fence = fence_open(raw);
                    Kind::FenceOpen
                } else if indent_col(raw) >= 4 {
                    // ≥4 列三分流（与 md.ts 块层顺序互为镜像）：
                    //  上承段落 → 懒延续正文；上承列表项 → 项内容（≥6 列按 CommonMark 内容列+4 才算
                    //  缩进代码；4-5 列是嵌套列表项/项内 ATX——沿用两侧既有的"宽松 ATX"共同口径）；
                    //  其余 → 顶层缩进代码。
                    let t = raw.trim();
                    if prev == Kind::Para {
                        Kind::Para
                    } else if prev == Kind::List {
                        // 列表内容：深缩进(≥6)按 CommonMark 该算代码，但 4-8 空格嵌套列表是存量
                        // 文档的普遍写法——两侧统一沿用宽松口径（项内容列不分深浅），记录为已批准偏差。
                        if t.starts_with('#') {
                            Kind::Head
                        } else if after_list_marker(raw).is_some() {
                            Kind::List
                        } else {
                            Kind::Para
                        }
                    } else {
                        Kind::Code
                    }
                } else {
                    let t = raw.trim();
                    if t.starts_with('#') {
                        Kind::Head
                    } else if adj_par && (t.chars().all(|c| c == '=') || t.chars().all(|c| c == '-')) {
                        // Setext 下划线：整行同一字符（=→h1，-→h2），只接**紧邻**段落（空行断开→落到 hr；
                        // 与 md.ts 块层的段落缓冲同判据；hr 与 setext 的先后按此判定）
                        Kind::Setext(if t.starts_with('=') { 1 } else { 2 })
                    } else if is_hr(t) {
                        Kind::Hr
                    } else if list_start(raw, adj_par) {
                        Kind::List
                    } else if t.starts_with('>') {
                        Kind::Quote
                    } else if t.starts_with('<') {
                        Kind::Other
                    } else {
                        Kind::Para
                    }
                }
            }
        };
        if k != Kind::Blank {
            prev = k;
        }
        adj_par = k == Kind::Para;
        out[idx] = k;
    }
    out
}

/// YAML front matter：首行恰为 `---` 时向后找 `---`/`...` 收口行，返回其下标；
/// 无收口（如文档以孤立 hr 开头）→ None。↔ md.ts frontMatterEnd 同判据。
pub(crate) fn front_matter_end(lines: &[&str]) -> Option<usize> {
    if lines.first()?.trim_end() != "---" {
        return None;
    }
    (1..lines.len()).find(|&i| matches!(lines[i].trim_end(), "---" | "..."))
}

/// 分隔线（GFM 4.1 变体）：≥3 个同一 -/_/*，字符间可夹空白，行尾可空白。
fn is_hr(t: &str) -> bool {
    let mut it = t.chars();
    let Some(c) = it.next() else { return false };
    if c != '-' && c != '_' && c != '*' {
        return false;
    }
    let mut n = 1usize;
    let mut last = c;
    for ch in it {
        if ch == c {
            if last != c && last != ' ' && last != '\t' {
                return false;
            }
            n += 1;
        } else if ch != ' ' && ch != '\t' {
            return false;
        }
        last = ch;
    }
    n >= 3
}

/// ATX 标题提取：围栏/缩进代码/Setext 下划线一律跳过；闭合 `#` 串去掉；
/// Setext 标题的 line 记段落首行（与 md.ts 渲染块的 data-line-start 同值）。
pub fn headings(src: &str) -> Vec<Heading> {
    let norm = normalize(src);
    let lines: Vec<&str> = norm.lines().collect();
    let kinds = line_kinds(&norm);
    let mut out: Vec<Heading> = Vec::new();
    // 段落运行起点（连续 Para 行的第一行），供 Setext 引用
    let mut para_run: Option<usize> = None;
    for (i, raw) in lines.iter().enumerate() {
        let k = kinds[i];
        match k {
            Kind::Para => {
                if para_run.is_none() {
                    para_run = Some(i);
                }
            }
            Kind::Setext(lv) => {
                let start = para_run.take().unwrap_or(i.saturating_sub(1));
                let text = lines[start..i].join(" ").trim().to_string();
                out.push(Heading { sec: (out.len() + 1) as i64, level: lv as i64, text, line: start as i64 });
            }
            Kind::Head => {
                para_run = None;
                let t = raw.trim_start();
                let hashes = t.chars().take_while(|c| *c == '#').count();
                if hashes == 0 || hashes > 6 {
                    continue;
                }
                let rest: String = t.chars().skip(hashes).collect();
                // '#' 后必须跟空白或行尾（排除 "###tag"）
                if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
                    continue;
                }
                let mut text = rest.trim().to_string();
                if text.ends_with('#') {
                    let cut = text.trim_end_matches('#');
                    if cut.is_empty() || cut.ends_with(' ') || cut.ends_with('\t') {
                        text = cut.trim_end().to_string();
                    }
                }
                out.push(Heading { sec: (out.len() + 1) as i64, level: hashes as i64, text, line: i as i64 });
            }
            _ => {
                para_run = None;
            }
        }
    }
    out
}

/// (word_count, head_count, sec_count)。
/// word_count 口径（2026-11-17 需求方定夺）：源文本非空白字符数，但**跳过公式块与图表块**
/// （`$$…$$`、```math、```mermaid 整块含围栏行；普通代码围栏维持旧口径照计）。
/// 与前端 lib/wordcount.ts 逐行同规则——两侧钉桩测试用同一 fixture，改一边必须同步另一边。
/// head_count = 大纲条目（h1~h6）；sec_count = 小节（h2~h6）——口径不受 word 跳过影响。
pub fn stats(src: &str) -> (i64, i64, i64) {
    let hs = headings(src);
    let word_count = prose_chars(src);
    let head_count = hs.len() as i64;
    let sec_count = hs.iter().filter(|h| h.level >= 2).count() as i64;
    (word_count, head_count, sec_count)
}

/// 数学/图表围栏语言判定：开启围栏 info 首词为 math / mermaid（大小写不敏感；~~~ 同规则）。
fn is_skipped_fence(line: &str) -> bool {
    fence_info(line).to_lowercase() == "math" || fence_info(line).to_lowercase() == "mermaid"
}

/// 按 word 口径剔除非正文块后的非空白码点数
fn prose_chars(src: &str) -> i64 {
    let norm = normalize(src); // P2 输入预处理（↔ wordcount.ts）
    let mut n = 0usize;
    let mut fence: Option<(char, usize)> = None;
    let mut code_skipped = false;
    let mut in_math = false;
    for raw in norm.lines() {
        if let Some(open) = fence {
            if fence_close(raw, open) {
                fence = None;
                if !code_skipped {
                    n += raw.chars().filter(|c| !c.is_whitespace()).count(); // 闭合围栏标记照旧计入
                }
            } else if !code_skipped {
                n += raw.chars().filter(|c| !c.is_whitespace()).count();
            }
            continue;
        }
        if !in_math {
            if let Some(open) = fence_open(raw) {
                fence = Some(open);
                code_skipped = is_skipped_fence(raw);
                if !code_skipped {
                    n += raw.chars().filter(|c| !c.is_whitespace()).count(); // 普通围栏标记照旧计入
                }
                continue;
            }
        }
        let t = raw.trim();
        if t == "$$" {
            in_math = !in_math; // 界行本身不计
            continue;
        }
        if in_math {
            continue;
        }
        n += raw.chars().filter(|c| !c.is_whitespace()).count();
    }
    n as i64
}

/// 列表行拆分：若该行以 "缩进 + (-|*|+|n.|n\)) + 空白" 开头，返回标记段之后的剩余切片。
/// 全程按字符迭代取字节偏移，多字节安全。
fn after_list_marker(line: &str) -> Option<&str> {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut i = 0usize;
    while i < chars.len() && (chars[i].1 == ' ' || chars[i].1 == '\t') {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    let mut j = i;
    let c0 = chars[i].1;
    if c0 == '-' || c0 == '*' || c0 == '+' {
        j += 1;
    } else {
        let mut k = i;
        while k < chars.len() && chars[k].1.is_ascii_digit() {
            k += 1;
        }
        if k == i || k >= chars.len() || (chars[k].1 != '.' && chars[k].1 != ')') {
            return None;
        }
        j = k + 1;
    }
    // 标记即整行（"-"/"1."）= 空列表项，Some("")（CC 5.2，2026-11-21 第三档 audit 5.2-b）
    if j >= chars.len() {
        return Some("");
    }
    if !(chars[j].1 == ' ' || chars[j].1 == '\t') {
        return None;
    }
    while j < chars.len() && (chars[j].1 == ' ' || chars[j].1 == '\t') {
        j += 1;
    }
    if j >= chars.len() {
        return Some("");
    }
    Some(&line[chars[j].0..])
}

/// 列表行起始（line_kinds 用；↔ md.ts isListStartKind，CC 5.2 打断段落三条件，audit 5.2-a）：
/// 标记命中即可；打断紧邻段落时——空项不得打断；有序项数字必须是 1。
fn list_start(line: &str, interrupting_para: bool) -> bool {
    let Some(rest) = after_list_marker(line) else { return false };
    if !interrupting_para {
        return true;
    }
    if rest.trim().is_empty() {
        return false;
    }
    let t = line.trim_start();
    if t.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
        return digits.trim_start_matches('0') == "1";
    }
    true
}

/// 任务行拆分：返回（'[' 之前的前缀字节长, 勾选字符, ']' 的绝对字节偏移）。
fn task_parts(line: &str) -> Option<(usize, char, usize)> {
    let body = after_list_marker(line)?;
    let bc: Vec<(usize, char)> = body.char_indices().collect();
    if bc.len() < 3 || bc[0].1 != '[' || bc[2].1 != ']' {
        return None;
    }
    let state = bc[1].1;
    if state != ' ' && state != 'x' && state != 'X' {
        return None;
    }
    let head_len = line.len() - body.len();
    Some((head_len, state, head_len + bc[2].0))
}

/// 切换第 nth 个（0 起）**可勾选**任务行的状态；越界返回 None。
/// 与渲染器同坐标系（评审 v2·N3 + 2026-11-21 第二档）：围栏内、缩进代码内的假任务不计数——
/// 计数走 line_kinds 同一状态机（List 行才可能是任务；懒延续/代码内不算）。
/// 保留行尾风格与文件末尾换行（P2 起逐行记终止符：混合 CRLF/LF/裸 CR 也逐字节原样）。
pub fn toggle_task(src: &str, nth: usize) -> Option<String> {
    let rows = split_lines_cr(src);
    let kinds = line_kinds(src);
    let mut seen = 0usize;
    for (i, (raw, _term)) in rows.iter().enumerate() {
        if kinds.get(i) != Some(&Kind::List) {
            continue;
        }
        let Some((head_len, state, tail_off)) = task_parts(raw) else { continue };
        if seen == nth {
            let new_state = if state == ' ' { 'x' } else { ' ' };
            let mut out = String::with_capacity(src.len());
            for (j, (c, term)) in rows.iter().enumerate() {
                if j == i {
                    out.push_str(&c[..head_len]);
                    out.push('[');
                    out.push(new_state);
                    out.push_str(&c[tail_off..]);
                } else {
                    out.push_str(c);
                }
                out.push_str(term);
            }
            return Some(out);
        }
        seen += 1;
    }
    None
}

/// 文件名 → 深度链接 slug 基形：去扩展名，保留字母数字/汉字（近似码点判断），
/// 其余转 '-'，转小写。
pub fn slugify(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || (c as u32) > 0x2E7F {
            out.extend(c.to_lowercase());
            continue;
        }
        if c == '-' || c == '_' || c == ' ' || c == '.' {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "doc".to_string() } else { out }
}

/// 在已占用集合内保证唯一：base, base-2, base-3 …
pub fn unique_slug(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let cand = format!("{base}-{n}");
        if !taken.contains(&cand) {
            return cand;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_skip_fences() {
        let src = "# T\n\n```md\n# 假标题\n```\n\n## 真小节 ##\n";
        let hs = headings(src);
        assert_eq!(hs.len(), 2);
        assert_eq!(hs[0].text, "T");
        assert_eq!(hs[1].text, "真小节");
        assert_eq!(hs[1].level, 2);
    }

    #[test]
    fn second_batch_kinds_gfm() {
        // 2026-11-21 第二档：围栏配对 / Setext / 缩进代码（与 tests/md.test.ts 镜像双跑）
        let hs = headings("~~~\n# 假标题(围栏)\n~~~\n");
        assert_eq!(hs.len(), 0, "~~~ 内不计");
        let hs2 = headings("````md\n``` js\n# 假\n```\n````\n# 真\n");
        assert_eq!(hs2.len(), 1, "四反引号内三反引号是内容");
        let hs3 = headings("````\n```\n# 仍围栏内\n");
        assert_eq!(hs3.len(), 0, "短闭栏不闭合");
        let hs4 = headings("标题一\n=====\n\n小节\n---\n\n正文\n");
        assert_eq!(hs4.len(), 2);
        assert_eq!((hs4[0].level, hs4[0].line), (1, 0));
        assert_eq!((hs4[1].level, hs4[1].line), (2, 3));
        assert_eq!(headings("---\n正文\n").len(), 0, "无前置段落 --- 是 hr");
        assert_eq!(headings("段落\n\n---\n\n再段\n===\n").len(), 1, "空行断开：--- 是 hr；贴段落的 === 才算标题");
        assert_eq!(headings("-\n正文\n").len(), 0, "无前置段落单破折号不算 setext");
        assert_eq!(headings("段落\n    # 懒延续\n\n正文\n    # 代码\n").len(), 0);
        assert_eq!(headings("- a\n    # 项内标题\n").len(), 1, "列表后 4 列 ATX：宽松口径计标题");
        assert_eq!(headings("# 前标题\n\n      # 缩进代码\n").len(), 1, "非列表语境深缩进行=缩进代码不计");
        assert_eq!(headings("----\n_ _ _\n# 真\n").len(), 1, "hr 变体");
    }

    #[test]
    fn p2_batch_input_normalization() {
        // P2（2026-11-21）：裸 CR 与 CRLF/LF 同样分行（CommonMark 0.1）；NUL→U+FFFD（2.1）
        let hs = headings("# 标题一\r# 标题二\r\n正文\r    # 代码行\r");
        assert_eq!(hs.len(), 2, "裸 CR 分行；分行后 4 列缩进行是懒延续不计标题");
        assert_eq!((hs[1].sec, hs[1].level, hs[1].line), (2, 1, 1));
        let nul = headings("# 标题\u{0}甲\n");
        assert_eq!(nul[0].text, "标题\u{FFFD}甲", "NUL 按规范替换为 U+FFFD");
        // 写回侧：按原终止符逐行重建——混合行尾也逐字节不动
        assert_eq!(toggle_task("- [ ] a\r- [ ] b\n", 1).unwrap(), "- [ ] a\r- [x] b\n");
        assert_eq!(toggle_task("- [ ] a", 0).unwrap(), "- [x] a");
        // 制表位：tab=4 列 → 顶格 tab 的围栏仍是围栏（缩进不设上限偏差）
        let htab = headings("\t```\n# 栏内\n\t```\n# 出栏\n");
        assert_eq!(htab.len(), 1, "tab 缩进围栏配对：# 出栏 sec=1");
        assert_eq!(htab[0].sec, 1);
    }

    #[test]
    fn front_matter_skipped() {
        // YAML front matter（GitHub/Jekyll 扩展，2026-11-22；↔ tests/md.test.ts 同料）
        let hs = headings("---\ntitle: 示例文档\ntags: [gfm, folio]\n---\n\n# 正文标题\n正文\n");
        assert_eq!(hs.len(), 1, "头部区不产标题；收口 --- 不得变 Setext");
        assert_eq!((hs[0].sec, hs[0].line, hs[0].text.as_str()), (1, 5, "正文标题"));
        // 区内假任务不计
        assert!(toggle_task("---\n- [ ] yaml\n---\n\n- [ ] 真\n", 0).unwrap().contains("[x] 真"));
        // 未收口 → 不是头部（首行仍 hr，正文照常计标题）
        assert_eq!(headings("---\n# 真标题\n").len(), 1);
        // "..." 收口同样有效
        assert_eq!(headings("---\nt: x\n...\n\n# A\n").len(), 1);
        // 头部之后 Setext 不受污染：正文+=== 仍计 h1（=→h1）
        let hs2 = headings("---\nt: x\n---\n\n正文\n===\n");
        assert_eq!((hs2.len(), hs2[0].level, hs2[0].line), (1, 1, 4));
    }

    #[test]
    fn third_batch_list_kinds() {
        // 空列表项：标记即整行仍是 List（audit 5.2-b）——夹在中间不吞任务序号
        assert_eq!(toggle_task("- [ ] a\n-\n- [ ] b\n", 1).unwrap(), "- [ ] a\n-\n- [x] b\n");
        // 非 1 起始的有序列表不打断段落（audit 5.2-a）→ 该行是段落文字，任务不计
        assert!(toggle_task("para\n2. [ ] t\n", 0).is_none(), "2. 不打断段落");
        assert!(toggle_task("para\n1. [ ] t\n", 0).is_some(), "1. 可打断");
        assert!(toggle_task("para\n0. [ ] t\n", 0).is_none(), "0. 不可打断");
        assert!(toggle_task("para\n\n2. [ ] t\n", 0).is_some(), "空行后非段落语境照常成列表");
        assert!(toggle_task("para\n-\n", 0).is_none(), "空项不打断段落（setext 语境另有覆盖）");
        // 大纲：段落后的 "2. x" 不是列表也不是标题
        assert_eq!(headings("para\n2. # 不是标题\n").len(), 0);
    }

    #[test]
    fn second_batch_task_coordinate() {
        let src = "~~~\n- [ ] 围栏内假\n~~~\n\n```js\n- [ ] 反引号内假\n```\n\n# 标题\n\n    - [ ] 缩进代码假\n\ntext\n    - [ ] 懒延续假\n\n- [ ] 真一\n";
        let flipped = toggle_task(src, 0).expect("有且仅有一个真任务");
        assert!(flipped.contains("- [x] 真一"));
        assert!(toggle_task(&flipped, 1).is_none(), "假任务全部出局");
    }


    #[test]
    fn headings_need_space_after_hashes() {
        assert!(headings("#tag 不算标题").is_empty());
        assert_eq!(headings("#! 也不算").len(), 0);
        assert_eq!(headings("# 算").len(), 1);
    }

    #[test]
    fn stats_counts() {
        let (_w, h, s) = stats("# A\n\n文字四个字。\n\n## B\n");
        assert_eq!(h, 2);
        assert_eq!(s, 1);
    }

    #[test]
    fn toggle_task_ignores_fenced_fake() {
        let src = "- [ ] real one\n\n```text\n- [ ] fake in code\n```\n\n- [ ] real two\n";
        let out = toggle_task(src, 0).unwrap();
        assert!(out.contains("[x] real one"));
        assert!(out.contains("- [ ] fake in code"));
        let out2 = toggle_task(&out, 1).unwrap();
        assert!(out2.contains("[x] real two"));
        assert!(toggle_task(src, 2).is_none());
    }

    #[test]
    fn toggle_task_preserves_ordered_and_indent() {
        let out = toggle_task("  1. [ ] indented item\n", 0).unwrap();
        assert_eq!(out, "  1. [x] indented item\n");
    }

    #[test]
    fn toggle_task_multibyte_prefix_and_crlf() {
        // 列表标记与勾选框之间是 ASCII；行尾 CRLF 保留
        let out = toggle_task("- [ ] 中文任务\r\n正文\r\n", 0).unwrap();
        assert_eq!(out, "- [x] 中文任务\r\n正文\r\n");
    }

    #[test]
    fn toggle_task_no_trailing_newline_added() {
        assert_eq!(toggle_task("- [ ] a", 0).unwrap(), "- [x] a");
    }

    // ── 跨语言契约钉桩（审查报告 v1.0 CON-01/CON-02）：改这里的任一判定必须同步 src/lib/md.ts ──

    #[test]
    fn headings_accept_indent_and_bare_hash_reject_quote_prefix() {
        let src = "# Top\n\n  # Indented\n\n#\n\n> # Quoted\n";
        let hs = headings(src);
        assert_eq!(hs.len(), 3, "Rust 是权威口径：缩进与裸 # 计标题，引用前缀不计");
        assert_eq!(hs[2].text, "");
        assert_eq!(hs[2].sec, 3);
    }

    #[test]
    fn toggle_task_skips_quoted_tasks() {
        // 渲染器（md.ts nested 分支）必须同样不给引用块任务生成 data-task——否则序号错位勾错行
        let src = "> - [ ] quoted\n\n- [ ] real\n";
        let out = toggle_task(src, 0).unwrap();
        assert!(out.contains("> - [ ] quoted"), "引用行不许被改写");
        assert!(out.contains("- [x] real"));
        assert!(toggle_task(src, 1).is_none(), "全篇可勾选任务只有 1 个");
    }

    #[test]
    fn task_without_space_after_bracket_counts() {
        // "- [ ]x"：Rust task_parts 不要求 ] 后空白，TS 渲染器同步放宽（\s* 而非 \s+）
        let out = toggle_task("- [ ]x\n", 0).unwrap();
        assert_eq!(out, "- [x]x\n");
    }

    #[test]
    fn stats_skips_math_and_diagram_blocks() {
        // 与前端 tests/wordcount.test.ts 共用同一 fixture：期望值必须一致（=24）
        let src = "# A\n\n正文四字。\n\n$$\n\\frac{1}{2}\n$$\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nlet x=1\n```\n\n## B\n";
        let (w, h, s) = stats(src);
        // 期望 24 = #A(2)+正文四字。(5)+```js(5)+letx=1(6)+```(3)+##B(3)；
        // $$ 界行、\frac 内容行与 mermaid 整块剔除。与 TS wordcount.test.ts 同数字（跨语言契约）
        assert_eq!(w, 24, "正文+js 围栏计数；公式/图表内容整剔");
        assert_eq!(h, 2, "标题数不受 word 口径影响");
        assert_eq!(s, 1);
        assert_eq!(stats("$$\n\\frac{1}{2}\n$$\n").0, 0);
        assert_eq!(stats("```math\nE=mc^2\n```\n").0, 0);
        assert_eq!(stats("```MERMAID\ngraph TD\nA-->B\n```\n").0, 0, "大小写不敏感");
        assert!(stats("```js\nlet x=1\n```\n").0 > 0, "普通代码块照旧计入");
        // 未闭合 $$ 吃到 EOF；块内 ``` 不误判为围栏
        assert_eq!(stats("$$\n```\nx\n").0, 0);
        // 第二档（2026-11-21）：~~~ 围栏同跳、变长配对（↔ tests/wordcount.test.ts 同值）
        assert_eq!(stats("~~~mermaid\ngraph TD\nA-->B\n~~~\n").0, 0, "~~~mermaid 整块剔除");
        assert_eq!(stats("~~~\nx\n~~~~\n").0, 8, "~~~ 被更长的 ~~~~ 关闭：3+1+4 全计");
    }

    #[test]
    fn slug_and_unique() {
        assert_eq!(slugify("Rust Notes.md"), "rust-notes");
        assert_eq!(slugify("架构设计 v3.md"), "架构设计-v3");
        let mut taken = HashSet::new();
        taken.insert("a".to_string());
        assert_eq!(unique_slug("a", &taken), "a-2");
    }
}
