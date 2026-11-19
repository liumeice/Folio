//! 1–2 字短查询的字符位图预筛（性能复检 2026-11-18 P1）。
//!
//! 背景：FTS5 trigram 只支持 ≥3 字符；不足 3 字原先走 `body LIKE '%x%'`，
//! 在 442 篇/13.4MB 上约 58–60ms，2000 篇会线性放大。这里为每篇文档存一张
//! 65536 位的 BMP 字符位图（8KB/篇），短查询先按位图圈定候选文档，再做精确
//! section 搜索——不再扫描全库正文。位图只用于「字是否出现」的预筛，顺序/词义
//! 仍由现有精确搜索验证。
//!
//! 覆盖范围：Unicode BMP（中文、拉丁、常用符号）。查询字符超出 BMP 时返回 None，
//! 调用方回退原 LIKE（emoji/扩展区搜索较少，不做额外索引）。

pub const BITMAP_BYTES: usize = 8192; // 65536 bits

fn bit_set(bits: &mut [u8], ch: char) {
    let cp = ch as u32;
    if cp < (BITMAP_BYTES * 8) as u32 {
        let i = cp as usize;
        bits[i >> 3] |= 1 << (i & 7);
    }
}

fn bit_has(bits: &[u8], ch: char) -> bool {
    let cp = ch as u32;
    if cp >= (BITMAP_BYTES * 8) as u32 || bits.len() < BITMAP_BYTES {
        return false;
    }
    let i = cp as usize;
    bits[i >> 3] & (1 << (i & 7)) != 0
}

/// 文档字符位图：原字符 + 小写形式都置位（ASCII 大小写不敏感；中文原样）。
pub fn bitmap(src: &str) -> Vec<u8> {
    let mut bits = vec![0u8; BITMAP_BYTES];
    for ch in src.chars() {
        bit_set(&mut bits, ch);
        for lc in ch.to_lowercase() {
            bit_set(&mut bits, lc);
        }
    }
    bits
}

/// 查询字符（小写化后的 1–2 个 BMP 字符）；超出范围/长度时 None = 回退 LIKE。
pub fn query_chars(q: &str) -> Option<Vec<char>> {
    let mut out = Vec::with_capacity(2);
    for ch in q.chars() {
        for lc in ch.to_lowercase() {
            out.push(lc);
            if out.len() > 2 {
                return None;
            }
        }
    }
    if out.is_empty() || out.iter().any(|c| (*c as u32) >= (BITMAP_BYTES * 8) as u32) {
        return None;
    }
    Some(out)
}

pub fn has(bits: &[u8], ch: char) -> bool {
    bit_has(bits, ch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmap_contains_original_and_lowercase() {
        let b = bitmap("Hello 大纲");
        assert!(has(&b, 'H'));
        assert!(has(&b, 'h'));
        assert!(has(&b, '大'));
        assert!(has(&b, '纲'));
        assert!(!has(&b, '猫'));
        assert_eq!(b.len(), BITMAP_BYTES);
    }

    #[test]
    fn query_chars_lowercases_and_bounds() {
        assert_eq!(query_chars("AB"), Some(vec!['a', 'b']));
        assert_eq!(query_chars("大纲"), Some(vec!['大', '纲']));
        assert_eq!(query_chars("三字符"), None);
        assert_eq!(query_chars(""), None);
    }
}