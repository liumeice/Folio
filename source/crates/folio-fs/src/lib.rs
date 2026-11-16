//! folio-fs — 文件系统访问
//! M0：同步 std::fs（本地文档毫秒级，够用）；文件监听（notify）与增量索引 M1 接。

use folio_core::{CoreError, Result};
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

/// 读取 Markdown：去 BOM；非法字节 lossy（原型契约：UTF-8 优先，坏文件不致命）
pub fn read_md(path: &Path) -> Result<String> {
    if !path.is_file() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    if !is_supported(path) {
        return Err(CoreError::Unsupported(path.display().to_string()));
    }
    let bytes = fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text.strip_prefix('\u{FEFF}').map(str::to_string).unwrap_or(text))
}

/// 写回：先写临时文件再原子改名，避免半写状态丢原文
pub fn write_md(path: &Path, content: &str) -> Result<()> {
    write_text(path, content)
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("folio-tmp");
    fs::write(&tmp, content)?;
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
                    stack.push(p);
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

/// 新建文档：在 dir 下生成不重名的「未命名文档[ N].md」+ 起始模板，返回绝对路径。
/// 已存在同名绝不覆盖（逐个加编号让路）。
pub fn new_doc(dir: &str) -> Result<String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return Err(CoreError::NotFound(dir.to_string()));
    }
    let mut name = "未命名文档.md".to_string();
    let mut i = 1usize;
    while d.join(&name).exists() {
        name = format!("未命名文档 {i}.md");
        i += 1;
    }
    let p = d.join(&name);
    write_text(&p, "# 未命名文档\n\n")?;
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
    fn new_doc_never_overwrites() {
        let dir = std::env::temp_dir().join("folio-newdoc-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p1 = new_doc(dir.to_str().unwrap()).unwrap();
        let p2 = new_doc(dir.to_str().unwrap()).unwrap();
        assert!(p1.ends_with("未命名文档.md") && p2.ends_with("未命名文档 1.md"));
        assert_ne!(p1, p2);
        assert!(read_md(Path::new(&p2)).unwrap().starts_with("# 未命名文档"));
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
