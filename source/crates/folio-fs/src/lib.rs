//! folio-fs — 文件系统访问
//! M0：同步 std::fs（本地文档毫秒级，够用）；文件监听（notify）与增量索引 M1 接。

use folio_core::{CoreError, Result};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const EXTS: [&str; 3] = ["md", "markdown", "txt"];

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 字节 → (解码文本, 编码标签)。口径（2026-11-20 GBK/GB18030 + UTF-16）：
///  - BOM 嗅探最先行：FF FE → utf-16le、FE FF → utf-16be（**纯 ASCII 的 UTF-16 恰好也是合法
///    UTF-8**，不先拦会读出一串 NUL）；EF BB BF 走下方 UTF-8 路剥除；
///  - 无 BOM：严格 UTF-8 合法且无 NUL → utf-8（ASCII 也走这条）；否则 chardetng 猜测——
///    猜中 GBK/GB18030 → GB18030 解码（GBK 是子集，无损）；猜中 UTF-16LE/BE（ASCII 密集的 0x00
///    分布可靠，纯 CJK 无 BOM 端序天然歧义不承诺）→ 按端序解码；其余编码（Big5/Shift-Jis/单字节
///    乱猜）**不硬解**、退回 lossy UTF-8——宁可保真乱码，不可猜错把好文件解码成张冠李戴的汉字。
///  检测预算：只喂前 64KB（中文码页判定足够，整读大文件喂猜误判更快）。
pub fn decode_bytes(bytes: &[u8]) -> (String, String) {
    // BOM 嗅探必须最先行：纯 ASCII 的 UTF-16 恰好也是合法 UTF-8，晚一步就读出一串 NUL
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (cow.into_owned(), "utf-16le".into());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (cow.into_owned(), "utf-16be".into());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        // 含 NUL 的「合法 UTF-8」实为无 BOM UTF-16 的偶数位错位形态，交给检测器裁决
        if !s.contains('\0') {
            return (s.strip_prefix('\u{FEFF}').unwrap_or(s).to_string(), "utf-8".into());
        }
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(&bytes[..bytes.len().min(64 * 1024)], bytes.len() <= 64 * 1024);
    let enc = det.guess(None, true);
    if enc == encoding_rs::GBK || enc == encoding_rs::GB18030 {
        let label = if enc == encoding_rs::GBK { "gbk" } else { "gb18030" };
        let (cow, _, _had_err) = encoding_rs::GB18030.decode(bytes);
        return (cow.into_owned(), label.into());
    }
    // 无 BOM 但 ASCII 段密集的 UTF-16：chardetng 能靠 0x00 分布猜中端序；
    // 纯 CJK 无 BOM 时端序天然歧义（无空字节可依据），不承诺识别——记事本/VS 写 UTF-16 都带 BOM
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let (cow, _, _) = enc.decode(bytes);
        let label = if enc == encoding_rs::UTF_16LE { "utf-16le" } else { "utf-16be" };
        return (cow.into_owned(), label.into());
    }
    (String::from_utf8_lossy(bytes).into_owned(), "utf-8".into())
}

/// 文本 → 落盘字节：gbk/gb18030 按 GB18030 编码回写（GBK 码位字节与 GBK 相同，罕见字走四字节区间）；
/// utf-16le/be 手写编码（BOM + encode_utf16 按端序展开——**encoding_rs 只做 UTF-16 解码**，
/// 它的 `.encode()` 对 UTF-16 会悄悄退回 UTF-8，探针实测，不可依赖）；其余（含 utf-8）纯 UTF-8、不写 BOM。
pub fn encode_bytes(text: &str, enc: &str) -> Vec<u8> {
    match enc {
        "gbk" | "gb18030" => encoding_rs::GB18030.encode(text).0.into_owned(),
        "utf-16le" | "utf-16be" => {
            let le = enc == "utf-16le";
            let mut out = Vec::with_capacity(2 + text.encode_utf16().count() * 2);
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            for u in text.encode_utf16() {
                out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            out
        }
        _ => text.as_bytes().to_vec(),
    }
}

/// 读取 Markdown（解码 + 编码标签）：GBK/GB18030 中文文档 2026-11-20 起支持。
pub fn read_md_dec(path: &Path) -> Result<(String, String)> {
    if !path.is_file() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    if !is_supported(path) {
        return Err(CoreError::Unsupported(path.display().to_string()));
    }
    let bytes = fs::read(path)?;
    Ok(decode_bytes(&bytes))
}

/// 读取 Markdown：只取文本（内部与 read_md_dec 同一解码——搜索/扫描/大纲等
/// 所有字节入口自动获得同样的 GBK 解码，不再 lossy 出乱码）。
pub fn read_md(path: &Path) -> Result<String> {
    Ok(read_md_dec(path)?.0)
}

/// 写回：先写临时文件再原子改名，避免半写状态丢原文。按来源编码回写（utf-8 默认）。
pub fn write_md(path: &Path, content: &str) -> Result<()> {
    write_md_enc(path, content, "utf-8")
}

/// 按指定编码原子写：gbk/gb18030 回写 GB18030 字节，其余 UTF-8 无 BOM。
pub fn write_md_enc(path: &Path, content: &str, enc: &str) -> Result<()> {
    write_bytes(path, &encode_bytes(content, enc))
}

/// 通用读文本：不受 `is_supported` 扩展名白名单限制（导出的 settings.json 等也读得动）。
/// 与 read_md 同样做 BOM 剥离 + lossy 解码，只是不校验扩展名。
pub fn read_text(path: &Path) -> Result<String> {
    if !path.is_file() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    let bytes = fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text.strip_prefix('\u{FEFF}').map(str::to_string).unwrap_or(text))
}

/// 通用原子写（导出 HTML 等非 md 目标也走这条，FR-13.1）
pub fn write_text(path: &Path, content: &str) -> Result<()> {
    write_bytes(path, content.as_bytes())
}

/// 字节级原子写：临时文件 + 改名，避免半写状态丢原文
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("folio-tmp");
    fs::write(&tmp, bytes)?;
    if path.exists() {
        fs::remove_file(path)?; // Windows 上 rename 不覆盖既有文件
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 递归扫描目录内的支持文件。跳过隐藏目录与常见噪声目录；上限 max 个防呆。
/// 返回 (文件列表, truncated)——PERF-01：达到上限而中止时**继续数**剩余条目个数，
/// 让调用方能如实上报"实际还有多少没登记"，而不是让 skipped 永远是 0。
pub fn scan_dir(root: &Path, max: usize) -> Vec<PathBuf> {
    scan_dir_truncated(root, max).0
}

pub fn scan_dir_truncated(root: &Path, max: usize) -> (Vec<PathBuf>, usize) {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut overflow: usize = 0; // 超上限后被丢弃的条目数
    let mut stack = vec![root.to_path_buf()];
    let mut full = false;
    // P2-8：目录联接/符号链接可能成环。按 canonicalize 后的物理路径去重——
    // 同一真实目录只下钻一次，环不会反复遍历；无法 canonicalize 的路径退回原路径作键。
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    seen_dirs.insert(fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()));
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                // 满员后仍要下钻：计数口径 = "目录里到底有多少篇"，不是"我打算登记多少篇"
                if !matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git" | "__pycache__")
                    && !name.starts_with('.')
                {
                    let canon = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                    if seen_dirs.insert(canon) {
                        stack.push(p);
                    }
                }
            } else if is_supported(&p) && !name.starts_with('.') {
                if full {
                    overflow += 1;
                } else {
                    out.push(p);
                    if out.len() >= max {
                        full = true;
                    }
                }
            }
        }
    }
    out.sort();
    (out, overflow)
}

/// 文档库列表排序：mtime 新→旧
pub fn touch_sort_key(path: &Path) -> i64 {
    mtime_secs(path)
}

/* ── 目录列举：应用内文件/目录选择对话框的数据源（UI 规范 v1.1 §8.6）──
 * 只列一层（树/列表跟随点击逐级浏览，不递归、不登记、不写盘）；
 * 虚拟路径 MY_PC（"::my-pc"）= 「此电脑」节点，枚举盘符根。 */
pub const MY_PC: &str = "::my-pc";

pub struct FsEntry(pub String, pub String); // (name, path)
pub struct FsFile {
    pub name: String,
    pub path: String,
    pub mtime: i64,
    pub supported: bool,
}
pub struct DirListing {
    pub parent: Option<String>,
    pub dirs: Vec<FsEntry>,
    pub files: Vec<FsFile>,
}

/// Windows 下 "C:" / "C:\\" 都是盘符根；unix 只有 "/"
fn is_drive_root(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() >= 2 && b.len() <= 3 && b[0].is_ascii_alphabetic() && b[1] == b':') || s == "/"
}

pub fn list_dir(path: &str) -> Result<DirListing> {
    if path == MY_PC || path.is_empty() {
        let mut dirs = drives();
        dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        return Ok(DirListing { parent: None, dirs, files: Vec::new() });
    }
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(CoreError::NotFound(path.to_string()));
    }
    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsFile> = Vec::new();
    let rd = fs::read_dir(p)?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 隐藏条目不进浏览器（与 scan_dir 的防呆口径一致）
        }
        let fp = e.path();
        if fp.is_dir() {
            dirs.push(FsEntry(name, fp.to_string_lossy().into_owned()));
        } else {
            files.push(FsFile {
                supported: is_supported(&fp),
                name,
                path: fp.to_string_lossy().into_owned(),
                mtime: mtime_secs(&fp),
            });
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let parent = if is_drive_root(path) {
        Some(MY_PC.to_string())
    } else {
        p.parent().map(|pp| pp.to_string_lossy().into_owned()).or(Some(MY_PC.to_string()))
    };
    Ok(DirListing { parent, dirs, files })
}

#[cfg(windows)]
fn drives() -> Vec<FsEntry> {
    (b'A'..=b'Z')
        .map(|c| {
            let letter = c as char;
            FsEntry(format!("{letter}:"), format!("{letter}:\\"))
        })
        .filter(|e| Path::new(&e.1).is_dir())
        .collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<FsEntry> {
    vec![FsEntry("/".into(), "/".into())]
}

/// 新建文档：在 dir 下生成不重名的「{untitled}[ N].md」+ 起始模板，返回绝对路径。
/// `untitled` 由前端按当前 UI 语言传入（多语言设计 §4.6.7 / 对照表 Rust #17–19），
/// Rust 不再产出面向用户的固定中文；已存在同名绝不覆盖（逐个加编号让路）。
pub fn new_doc(dir: &str, untitled: &str) -> Result<String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return Err(CoreError::NotFound(dir.to_string()));
    }
    // 文案来自本地目录，仍按 Windows 文件名规则收敛：剔除路径分隔等非法字符、去尾点/空格、限长
    let mut base: String = untitled
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    base = base.trim().trim_end_matches('.').trim().to_string();
    if base.is_empty() {
        base = "Untitled".into();
    }
    if base.chars().count() > 80 {
        base = base.chars().take(80).collect();
    }
    let mut name = format!("{base}.md");
    let mut i = 1usize;
    while d.join(&name).exists() {
        name = format!("{base} {i}.md");
        i += 1;
    }
    let p = d.join(&name);
    write_text(&p, &format!("# {base}\n\n"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// 确认框「里面有 M 篇」用：递归统计 root 下的支持文件数（scan_dir 同一过滤/上限口径）
pub fn count_md(root: &str, cap: usize) -> usize {
    let p = Path::new(root);
    if !p.is_dir() {
        return 0;
    }
    scan_dir(p, cap).len()
}

/// P2-3：图片头解析取像素尺寸（PNG/JPEG/GIF/WebP，不解码正文）。未知格式/解析失败 → None。
pub fn img_dims(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut f = fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096]; // JPEG 前置段（EXIF 等）可能较长，4KB 足够常见情形
    let n = f.read(&mut buf).ok()?;
    dims_of(&buf[..n])
}

fn dims_of(b: &[u8]) -> Option<(u32, u32)> {
    // PNG：8 字节签名 + IHDR(w,h 大端 32bit @16/20)
    if b.len() >= 24
        && b[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        && &b[12..16] == b"IHDR"
    {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        return if w > 0 && h > 0 { Some((w, h)) } else { None };
    }
    // GIF："GIF8" + 8 字节逻辑屏描述符(w,h 小端 16bit @6/8)
    if b.len() >= 10 && &b[..4] == b"GIF8" {
        let w = u16::from_le_bytes([b[6], b[7]]) as u32;
        let h = u16::from_le_bytes([b[8], b[9]]) as u32;
        return if w > 0 && h > 0 { Some((w, h)) } else { None };
    }
    // WEBP：RIFF/WEBP + VP8X（画布 24bit 小端 -1 @24/27）或 VP8 （lossy：@26/28 14bit）；VP8L 少见不解析
    if b.len() >= 30 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        if &b[12..16] == b"VP8X" {
            let w = 1 + u32::from_le_bytes([b[24], b[25], b[26], 0]);
            let h = 1 + u32::from_le_bytes([b[27], b[28], b[29], 0]);
            return Some((w, h));
        }
        if &b[12..16] == b"VP8 " {
            let w = (u16::from_le_bytes([b[26], b[27]]) & 0x3fff) as u32;
            let h = (u16::from_le_bytes([b[28], b[29]]) & 0x3fff) as u32;
            return if w > 0 && h > 0 { Some((w, h)) } else { None };
        }
    }
    // JPEG：SOI 后扫段头，SOFn(0xC0..0xCF 除 C4/C8/CC) 含 h@+5、w@+7（大端）
    if b.len() >= 4 && b[..2] == [0xff, 0xd8] {
        let mut i = 2usize;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let m = b[i + 1];
            if m == 0xd8 || m == 0x01 || (0xd0..=0xd9).contains(&m) {
                i += 2;
                continue; // 无长度字段的独立标记
            }
            if (0xc0..=0xcf).contains(&m) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return if w > 0 && h > 0 { Some((w, h)) } else { None };
            }
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            i += 2 + len.max(2);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_supported_checks_ext() {
        assert!(is_supported(Path::new("a.md")));
        assert!(is_supported(Path::new("a.MARKDOWN")));
        assert!(!is_supported(Path::new("a.rs")));
        assert!(!is_supported(Path::new("noext")));
    }

    #[test]
    fn write_atomic_roundtrip_and_bom() {
        let dir = std::env::temp_dir().join("folio-fs-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.md");
        write_md(&f, "# hi\n").unwrap();
        write_md(&f, "# hi2\n").unwrap(); // 覆盖路径
        let s = read_md(&f).unwrap();
        assert_eq!(s, "# hi2\n");
        fs::write(&f, "\u{FEFF}# bom").unwrap();
        assert_eq!(read_md(&f).unwrap(), "# bom");
        assert!(!f.with_extension("folio-tmp").exists());
    }

    #[test]
    fn gbk_detect_decode_and_roundtrip() {
        // 真实 GBK 码页字节：足够长的中文段落喂给 chardetng
        let zh = "# 字体下载说明\n\n\
            这是一个中文文档，包含常见汉字用于编码检测：程序编辑器阅读收藏笔记\
            工具文件夹搜索索引标题段落引用代码表格链接图片导出主题设置字体\n";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(zh);
        let (text, label) = decode_bytes(&gbk_bytes);
        assert_eq!(text, zh, "GBK 字节必须解回原文：{label}");
        assert!(label == "gbk" || label == "gb18030", "标签报码族：{label}");
        // 回写按 GB18030 编码，再解必须无损
        let again = encode_bytes(&text, &label);
        let (text2, _) = decode_bytes(&again);
        assert_eq!(text2, zh, "GBK→GB18030→GBK 往返无损");
        // UTF-8 与 BOM 走严格路，不碰检测器
        assert_eq!(decode_bytes("中文".as_bytes()).1, "utf-8");
        assert_eq!(decode_bytes("\u{FEFF}hi".as_bytes()).0, "hi");
        // 猜不中的垃圾字节保真 lossy（不张冠李戴硬解）；注意别用 FF FE 开头（那是 LE BOM）
        let junk = [0x80u8, 0x80, 0x80, 0x80, 0x80];
        assert_eq!(decode_bytes(&junk).1, "utf-8");
    }

    #[test]
    fn utf16_bom_and_no_bom_roundtrip() {
        // 关键防线：encode_bytes 必须真写成 UTF-16（encoding_rs 的 .encode 会把 UTF-16 悄悄退成 UTF-8，2026-11-20 实测）
        let zh = "# Unicode 测试文档\n\n一段足够长的中文，让 UTF-16 即使没有 BOM 也能被检测器认出来：\
                  程序、编辑器、阅读、收藏、笔记、工具、文件夹、搜索、索引、标题、段落、引用。\n";
        // BOM LE：往返必须字节级一致（我方编码器带 BOM）
        let le = encode_bytes(zh, "utf-16le");
        assert_eq!(&le[..2], &[0xFF, 0xFE], "LE 首字节必须是 BOM");
        assert_eq!(le.len(), 2 + zh.encode_utf16().count() * 2, "LE 长度 = BOM + 每码元 2 字节");
        let (t1, l1) = decode_bytes(&le);
        assert_eq!(t1, zh);
        assert_eq!(l1, "utf-16le");
        assert_eq!(encode_bytes(&t1, &l1), le, "LE 往返字节一致");
        // BOM BE
        let be = encode_bytes(zh, "utf-16be");
        assert_eq!(&be[..2], &[0xFE, 0xFF], "BE 首字节必须是 BOM");
        let (t2, l2) = decode_bytes(&be);
        assert_eq!(t2, zh);
        assert_eq!(l2, "utf-16be");
        assert_eq!(encode_bytes(&t2, &l2), be, "BE 往返字节一致");
        // 无 BOM 纯中文 UTF-16LE（剥掉 BOM 两字节）：端序天然歧义（CJK 码元无空字节可依据），
        // 明确不承诺识别——现状实测 chardetng 猜不中，落回 lossy utf-8 保真路，不许崩、不许硬解成
        // 张冠李戴。记事本/VS 写 UTF-16 一律带 BOM，带 BOM 的上面已全功能支持。
        let (t3, l3) = decode_bytes(&le[2..]);
        assert_eq!(l3, "utf-8", "无 BOM CJK UTF-16 不硬猜，按 fallback 标注");
        assert!(!t3.is_empty(), "fallback 也必须出文本（lossy），绝不报错打断打开");
        // 纯 ASCII 的 UTF-16：合法 UTF-8 + NUL 的陷阱形态，BOM 嗅探必须先拦
        let ascii = "hello world\n";
        let ale = encode_bytes(ascii, "utf-16le");
        let (t4, l4) = decode_bytes(&ale);
        assert_eq!(t4, ascii, "ASCII UTF-16 不许读出一串 NUL");
        assert_eq!(l4, "utf-16le");
        // UTF-8 BOM 仍走 utf-8 剥除路
        let (t5, l5) = decode_bytes("\u{FEFF}hi".as_bytes());
        assert_eq!((t5.as_str(), l5.as_str()), ("hi", "utf-8"));
    }

    #[test]
    fn write_md_enc_respects_label() {
        let dir = std::env::temp_dir().join("folio-fs-enc-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("g.md");
        let zh = "中文回写测试，需要足够多的汉字让检测器认得出码页：程序编辑器阅读收藏笔记工具。\n";
        write_md_enc(&f, zh, "gb18030").unwrap();
        let raw = fs::read(&f).unwrap();
        assert!(std::str::from_utf8(&raw).is_err(), "必须真是 GB 族字节，不是 UTF-8");
        let (text, label) = read_md_dec(&f).unwrap();
        assert_eq!(text, zh);
        assert!(label == "gbk" || label == "gb18030", "{label}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_doc_never_overwrites() {
        let dir = std::env::temp_dir().join("folio-newdoc-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p1 = new_doc(dir.to_str().unwrap(), "未命名文档").unwrap();
        let p2 = new_doc(dir.to_str().unwrap(), "未命名文档").unwrap();
        assert!(p1.ends_with("未命名文档.md") && p2.ends_with("未命名文档 1.md"));
        assert_ne!(p1, p2);
        assert!(read_md(Path::new(&p2)).unwrap().starts_with("# 未命名文档"));
        // 英文界面：前端传 "Untitled"，文件名与正文跟随
        let p3 = new_doc(dir.to_str().unwrap(), "Untitled").unwrap();
        assert!(p3.ends_with("Untitled.md"));
        assert!(read_md(Path::new(&p3)).unwrap().starts_with("# Untitled"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_splits_and_filters() {
        let dir = std::env::temp_dir().join("folio-listdir-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("a.md"), "# a").unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        fs::write(dir.join("c.rs"), "c").unwrap();
        fs::write(dir.join(".hidden.md"), "h").unwrap();
        let l = list_dir(dir.to_str().unwrap()).unwrap();
        assert_eq!(l.dirs.len(), 1);
        assert_eq!(l.dirs[0].0, "notes");
        // supported 标记 + 隐藏条目过滤
        let names: Vec<&str> = l.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"a.md") && names.contains(&"b.txt") && names.contains(&"c.rs"));
        assert!(!names.contains(&".hidden.md"));
        assert!(l.files.iter().find(|f| f.name == "a.md").unwrap().supported);
        assert!(!l.files.iter().find(|f| f.name == "c.rs").unwrap().supported);
        // 盘符根之外都有上一级
        assert_eq!(l.parent.as_deref(), Some(dir.parent().unwrap().to_str().unwrap()));
        // 此电脑节点：能列且无父
        let pc = list_dir(MY_PC).unwrap();
        assert!(pc.parent.is_none() && !pc.dirs.is_empty());
        assert_eq!(count_md(dir.to_str().unwrap(), 100), 2); // a.md + b.txt（notes 空）
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dims_of_png_gif() {
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        png.extend(b"IHDR");
        png.extend(320u32.to_be_bytes());
        png.extend(240u32.to_be_bytes());
        assert_eq!(dims_of(&png), Some((320, 240)));
        let mut gif: Vec<u8> = vec![];
        gif.extend(b"GIF89a");
        gif.extend(64u16.to_le_bytes());
        gif.extend(32u16.to_le_bytes());
        assert_eq!(dims_of(&gif), Some((64, 32)));
    }

    #[test]
    fn dims_of_jpeg_skips_app_segments() {
        let mut b: Vec<u8> = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]; // APP0，段长 16
        b.extend(std::iter::repeat(0).take(14));
        b.extend([0xff, 0xc0, 0x00, 0x11, 0x08]); // SOF0，精度 8
        b.extend(480u16.to_be_bytes()); // h
        b.extend(640u16.to_be_bytes()); // w
        b.push(0); // 让窗口检查通过（真实文件后还有数据）
        assert_eq!(dims_of(&b), Some((640, 480)));
    }
}
