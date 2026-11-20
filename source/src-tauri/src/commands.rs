//! 命令层纯逻辑（无 tauri 依赖，可单测的形态；IO 全部 spawn_blocking 进这里）。
use folio_core::markdown;
use folio_core::{DocFull, DocMeta, OutlineItem, Position, Result, ScanReport, SearchHit, SearchQuery, SearchScope};
use folio_db::{Db, DocUpsert};
use folio_fs as fs;
use folio_search::{plan, Plan};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const SCAN_LIMIT: usize = 2000;
const SEARCH_DOC_CANDIDATES: i64 = 64;
const DEFAULT_HIT_LIMIT: i64 = 200;

pub fn outline_of(src: &str) -> Vec<OutlineItem> {
    markdown::headings(src)
        .into_iter()
        .map(|h| OutlineItem { sec: h.sec, level: h.level, text: h.text, line: h.line })
        .collect()
}

/* ── 最近打开缓存（性能报告 P2-6 变体 / P1-1 实质）──
 * 标签切换、重复打开时 mtime+size+in_library 戳一致 → 复用 src/outline，
 * 省掉磁盘读 + 大纲重算 + 大字符串 IPC 序列化（500KB 文档收益最大）；
 * meta 一律现读 DB，置顶/移出库/删除等状态零滞后。一致性判据与 P1-5 相同（NFR-4 约定）。 */
const OPEN_CACHE_MAX: usize = 6; // 小库上限 6 篇；总字节可控（6 × 文档大小），LRU 伪序靠全局递增号
#[derive(Clone)]
struct OpenedDoc {
    stamp: (i64, u64, bool), // mtime, size, in_library
    src: String,
    outline: Vec<OutlineItem>,
    enc: String, // 来源编码标签（utf-8/gbk/gb18030）：缓存命中也要如实带出，供保存回写
}
static OPEN_SEQ: AtomicU64 = AtomicU64::new(0);
static OPEN_CACHE: OnceLock<Mutex<HashMap<String, (u64, OpenedDoc)>>> = OnceLock::new();
fn open_cache() -> &'static Mutex<HashMap<String, (u64, OpenedDoc)>> {
    OPEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cache_put(key: String, stamp: (i64, u64, bool), src: String, outline: Vec<OutlineItem>, enc: String) {
    if stamp.0 == 0 {
        return; // 无可靠 mtime（特殊路径）不缓存
    }
    if let Ok(mut g) = open_cache().lock() {
        if g.len() >= OPEN_CACHE_MAX && !g.contains_key(&key) {
            let oldest = g.iter().min_by_key(|(_, (n, _))| *n).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                g.remove(&k);
            }
        }
        g.insert(key, (OPEN_SEQ.fetch_add(1, Ordering::Relaxed), OpenedDoc { stamp, src, outline, enc }));
    }
}

/// 重命名时搬运「打开篇」缓存的路径键：旧键删除、同内容挂到新键，
/// 保存→重开零读盘快捷路不被改名打掉（《Folio-目录树文件重命名方案》§3.2）。
fn cache_move_path(old: &str, new: &str) {
    if let Ok(mut g) = open_cache().lock() {
        if let Some(e) = g.remove(&old.to_lowercase()) {
            g.insert(new.to_lowercase(), e);
        }
    }
}

/* ── 搜索分节缓存（性能评审 P1-2）──
 * 全库搜索先由 FTS/LIKE 圈定候选文档，再逐篇读盘 + 分节 + 算片段。连续输入时同一批候选会被
 * 反复读取；这里按「路径 + mtime + size」缓存已分节结果（分节只依赖正文，命中片段仍按当前
 * query 现算）。写入路径（save / scan）显式作废，外部改文件由每次查询的 metadata 戳兜住。
 * 上限 16 篇 / 约 8MB 正文，超限按最久未用淘汰——搜索是辅助功能，不值得无界占内存。 */
const SEARCH_CACHE_DOCS: usize = 16;
const SEARCH_CACHE_BYTES: usize = 8 * 1024 * 1024;
struct CachedSections {
    mtime: i64,
    size: u64,
    bytes: usize,
    tick: u64,
    sections: Arc<Vec<folio_search::Section>>,
}
static SEARCH_SEQ: AtomicU64 = AtomicU64::new(0);
static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, CachedSections>>> = OnceLock::new();
fn search_cache() -> &'static Mutex<HashMap<String, CachedSections>> {
    SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 作废分节缓存：`Some(path)` = 单篇（保存后）；`None` = 全清（扫描后）。
/// 保存/扫描是仅有的正文写入口，缓存不需要额外的全局版本号。
pub fn invalidate_search_cache(path: Option<&str>) {
    if let Ok(mut g) = search_cache().lock() {
        match path {
            Some(p) => {
                g.remove(&p.to_lowercase());
            }
            None => g.clear(),
        }
    }
}

fn cached_sections(meta: &folio_core::DocMeta) -> Option<Arc<Vec<folio_search::Section>>> {
    let key = meta.path.to_lowercase();
    let path = Path::new(&meta.path);
    let mtime = fs::mtime_secs(path);
    let size = fs::file_size(path);
    if mtime <= 0 {
        return None; // 无可靠戳（特殊路径/文件已消失）→ 调用方走现读
    }
    if let Ok(mut g) = search_cache().lock() {
        if let Some(e) = g.get_mut(&key) {
            if e.mtime == mtime && e.size == size {
                e.tick = SEARCH_SEQ.fetch_add(1, Ordering::Relaxed);
                return Some(e.sections.clone());
            }
        }
    }
    let src = fs::read_md(path).ok()?;
    let secs = Arc::new(folio_search::sections(&src));
    let bytes = src.len();
    if bytes <= SEARCH_CACHE_BYTES {
        if let Ok(mut g) = search_cache().lock() {
            let mut total: usize = g.values().map(|e| e.bytes).sum();
            while (g.len() >= SEARCH_CACHE_DOCS || total + bytes > SEARCH_CACHE_BYTES) && !g.is_empty() {
                let oldest = g.iter().min_by_key(|(_, e)| e.tick).map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => {
                        if let Some(e) = g.remove(&k) {
                            total = total.saturating_sub(e.bytes);
                        }
                    }
                    None => break,
                }
            }
            g.insert(
                key,
                CachedSections {
                    mtime,
                    size,
                    bytes,
                    tick: SEARCH_SEQ.fetch_add(1, Ordering::Relaxed),
                    sections: secs.clone(),
                },
            );
        }
    }
    Some(secs)
}

/// unix 秒。与 documents.mtime / positions.updated_at / recents.opened_at 同一单位口径。
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 所有「打开」的唯一漏斗（open_doc / open_by_slug / 深链 / 拖拽 / 历史后退都走这里）：
/// 在这一点记打开历史，新入口不可能漏记；保存与勾选任务不经过此处，故不虚报「打开」。
/// `in_library` 由调用方给（v3 规则：打开单个文件不入库，见 `library_membership`）。
/// `record=false` = 未命名草稿（appdata/drafts 下）——需求方 2026-11-16 定夺：
/// 未保存的新建文档不进「最近打开」清单；另存为后按真实路径正常记录。
pub fn doc_full(db: &Arc<Db>, path: &Path, in_library: bool, record: bool) -> Result<DocFull> {
    let doc = doc_full_uncached(db, path, in_library)?;
    if record {
        let _ = db.record_recent(doc.meta.id, now_secs());
    }
    Ok(doc)
}

fn doc_full_uncached(db: &Arc<Db>, path: &Path, in_library: bool) -> Result<DocFull> {
    let key = path.to_string_lossy().to_lowercase();
    let mtime = fs::mtime_secs(path);
    let size = fs::file_size(path);
    let existing = db.doc_by_path(&key).ok();

    // 快路：DB 登记与磁盘一致 + 最近缓存命中 → 零读盘、零大纲重算、src 直接复用
    if mtime > 0 {
        if let Some(e) = existing.as_ref() {
            if e.mtime == mtime && e.size == size && e.in_library == in_library {
                if let Ok(mut g) = open_cache().lock() {
                    if let Some(en) = g.get_mut(&key) {
                        if en.1.stamp == (mtime, size, in_library) {
                            en.0 = OPEN_SEQ.fetch_add(1, Ordering::Relaxed);
                            return Ok(DocFull {
                                src: en.1.src.clone(),
                                outline: en.1.outline.clone(),
                                meta: e.clone(),
                                encoding: en.1.enc.clone(),
                            });
                        }
                    }
                }
            }
        }
    }

    let (src, encoding) = fs::read_md_dec(path)?; // GBK/GB18030 中文文档在此解码，标签随文带出
    let outline = outline_of(&src);
    // P1-5：打开只读化——未变则复用登记，跳过 markdown::stats 与 FTS trigram 重写
    let meta = match existing {
        Some(e) if e.mtime == mtime && e.size == size && e.in_library == in_library => e,
        _ => db.upsert_document(path, &src, in_library)?,
    };
    cache_put(key, (mtime, size, in_library), src.clone(), outline.clone(), encoding.clone());
    Ok(DocFull { src, outline, meta, encoding })
}

pub fn open_by_slug(db: &Arc<Db>, slug: &str) -> Result<DocFull> {
    let meta = db.doc_by_slug(slug)?;
    doc_full(db, Path::new(&meta.path), meta.in_library, true)
}

/// 保存（FR-7.5）：非 force 时，若磁盘 mtime 晚于登记 mtime ——判定外部已修改，
/// 返回 "CONFLICT" 错误串，由前端弹「覆盖 / 重新加载」二选一后再带 force 重试。
/// `encoding` = 该文档打开时检出的来源编码（gbk/gb18030 按原码页回写，其余 UTF-8；
/// 空串按 utf-8）——GBK 文档保存一次就转码毁掉原文的事不许发生。
pub fn save(db: &Arc<Db>, path: &str, content: &str, force: bool, encoding: &str) -> Result<DocFull> {
    let p = PathBuf::from(path);
    let enc = if encoding.is_empty() { "utf-8" } else { encoding };
    if !force {
        if let Ok(existing) = db.doc_by_path(path) {
            let disk = fs::mtime_secs(&p);
            if existing.mtime > 0 && disk > existing.mtime {
                return Err(folio_core::CoreError::Invalid("CONFLICT".into()));
            }
        }
    }
    fs::write_md_enc(&p, content, enc)?;
    invalidate_search_cache(Some(path)); // 正文已变：该篇的搜索分节缓存立刻作废
    // v3：保存不许改变库成员身份。旧代码硬写 true，会把「仅最近打开」的文件悄悄塞进库。
    // 有登记行 → 沿用其归属；新文件（理论上不会走到）→ 按库根判定。
    let in_library = db
        .doc_by_path(path)
        .map(|m| m.in_library)
        .unwrap_or_else(|_| db.library_membership(&p).unwrap_or(false));
    let meta = db.upsert_document(&p, content, in_library)?;
    let outline = outline_of(content);
    let src = content.to_string();
    // 保存后直写最近缓存：存盘→重开零读盘（mtime/size 取写盘后实测值）
    cache_put(
        p.to_string_lossy().to_lowercase(),
        (fs::mtime_secs(&p), fs::file_size(&p), in_library),
        src.clone(),
        outline.clone(),
        enc.to_string(),
    );
    Ok(DocFull { src, outline, meta, encoding: enc.to_string() })
}

/// 复选框回写：nth 与渲染端同一围栏坐标系（folio-core::markdown 单点实现）
pub fn toggle_task(db: &Arc<Db>, path: &str, nth: i64) -> Result<DocFull> {
    if nth < 0 {
        return Err(folio_core::CoreError::Invalid("nth < 0".into()));
    }
    let p = PathBuf::from(path);
    let (src, enc) = fs::read_md_dec(&p)?;
    let new_src = markdown::toggle_task(&src, nth as usize)
        .ok_or_else(|| folio_core::CoreError::NotFound(format!("task #{nth}")))?;
    // 勾选路径 = 读盘-改写-写盘，天然基于最新内容，不占冲突检测（FR-7.5 注）；编码随来源回写
    save(db, path, &new_src, true, &enc)
}

/// 文件名校验（唯一权威口径，《Folio-目录树文件重命名方案》§3.1）：
/// TS 镜像在 `src/lib/filename.ts`（错误码→人话文案），两侧规则一致——改一侧必双跑
/// （tests/filename.test.ts 逐条镜像这里，测试向量同码）。
pub fn validate_file_name(name: &str) -> Result<String> {
    let t = name.trim();
    if t.is_empty() {
        return Err(folio_core::CoreError::Invalid("EMPTY".into()));
    }
    if t.chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20)
    {
        return Err(folio_core::CoreError::Invalid("ILLEGAL_CHARS".into()));
    }
    if t.ends_with('.') || t.ends_with(' ') {
        return Err(folio_core::CoreError::Invalid("BAD_END".into()));
    }
    if t.chars().count() > 255 {
        return Err(folio_core::CoreError::Invalid("TOO_LONG".into()));
    }
    let lower = t.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
        return Err(folio_core::CoreError::Invalid("BAD_EXT".into()));
    }
    Ok(t.to_string())
}

/// 目录树「重命名」（《Folio-目录树文件重命名方案》）：磁盘改名 → 落库更新 path/slug；
/// doc_id 原地不动，进度/历史/FTS 零重写。**落库失败回滚磁盘**，任何失败都保留原名，
/// 绝不产生「盘上已改、库里没改」的半完成状态（验收要点最后一条）。
pub fn rename(db: &Arc<Db>, old_path: &str, new_name: &str) -> Result<DocMeta> {
    let name = validate_file_name(new_name)?;
    let meta = db.doc_by_path(old_path)?;
    let old = PathBuf::from(&meta.path);
    let parent = old
        .parent()
        .ok_or_else(|| folio_core::CoreError::Invalid("NO_DIR".into()))?
        .to_string_lossy()
        .to_string();
    let new = PathBuf::from(parent).join(&name);
    let new_str = new.to_string_lossy().to_string();
    if new_str == meta.path {
        return Ok(meta); // 完全同名 = 空操作
    }
    // Windows 文件系统不区分大小写：只改大小写 =「同一个文件」，重名检查必须放行（case_only），
    // 但 fs::rename 与库行仍要更新成新大小写形态。
    let case_only = new_str.to_lowercase() == meta.path.to_lowercase();
    if !case_only {
        if new.exists() || db.doc_by_path(&new_str).is_ok() {
            return Err(folio_core::CoreError::Invalid("EXISTS".into()));
        }
    }
    std::fs::rename(&old, &new)?;
    match db.rename_doc(meta.id, &new) {
        Ok(m) => {
            cache_move_path(&meta.path, &new_str);
            invalidate_search_cache(Some(&meta.path));
            invalidate_search_cache(Some(&new_str));
            Ok(m)
        }
        Err(e) => {
            let _ = std::fs::rename(&new, &old); // 回滚磁盘
            Err(e)
        }
    }
}

/// 目录名校验：文件规则去掉扩展名一项（文件夹无扩展名概念）。
/// TS 镜像 `src/lib/filename.ts::validateDirName`，改一侧必双跑。
pub fn validate_dir_name(name: &str) -> Result<String> {
    let t = name.trim();
    if t.is_empty() {
        return Err(folio_core::CoreError::Invalid("EMPTY".into()));
    }
    if t.chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20)
    {
        return Err(folio_core::CoreError::Invalid("ILLEGAL_CHARS".into()));
    }
    if t.ends_with('.') || t.ends_with(' ') {
        return Err(folio_core::CoreError::Invalid("BAD_END".into()));
    }
    if t.chars().count() > 255 {
        return Err(folio_core::CoreError::Invalid("TOO_LONG".into()));
    }
    Ok(t.to_string())
}

/// 文件夹「重命名」（增强 2026-11-20）：磁盘 rename → 子树文档路径 + roots 登记单事务换前缀。
/// 落库失败回滚磁盘；任何失败都不产生「盘已挪、库还在旧路」的半完成状态。
/// 成功后逐篇搬运打开篇缓存路径键，并全清搜索分节缓存（路径批量变，逐篇作废不如一把清）。
pub fn rename_dir(db: &Arc<Db>, old_path: &str, new_name: &str) -> Result<String> {
    let name = validate_dir_name(new_name)?;
    let old = PathBuf::from(old_path);
    if !old.is_dir() {
        return Err(folio_core::CoreError::NotFound(old_path.to_string()));
    }
    let parent = old
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| folio_core::CoreError::Invalid("NO_DIR".into()))?
        .to_path_buf();
    let new = parent.join(&name);
    let new_str = new.to_string_lossy().to_string();
    let old_str = old.to_string_lossy().to_string();
    if new_str == old_str {
        return Ok(new_str); // 完全同名 = 空操作
    }
    let case_only = new_str.to_lowercase() == old_str.to_lowercase();
    if !case_only && new.exists() {
        return Err(folio_core::CoreError::Invalid("EXISTS".into()));
    }
    std::fs::rename(&old, &new)?;
    match db.rename_dir(&old, &new) {
        Ok(moved) => {
            for (o, n) in moved {
                cache_move_path(&o, &n);
            }
            invalidate_search_cache(None);
            Ok(new_str)
        }
        Err(e) => {
            let _ = std::fs::rename(&new, &old); // 回滚磁盘
            Err(e)
        }
    }
}

/// 库根规范化（v5 毒路径源头掐断）：裸盘符 `D:` 补成 `D:\`——
/// PathBuf::from("D:").join(name) 会产出驱动器相对路径 `D:name`（Windows 按该盘 CWD 解析，
/// 磁盘上能读到、扫描"成功"，却让整个库的成员判定永久失效；实测中毒 1279 行）。
pub fn normalize_scan_root(root: &str) -> String {
    let b = root.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        format!("{}:\\", root.chars().next().unwrap())
    } else {
        root.to_string()
    }
}

pub fn scan(db: &Arc<Db>, root: &str) -> Result<ScanReport> {
    let root = normalize_scan_root(root);
    let rootp = PathBuf::from(&root);
    if !rootp.is_dir() {
        return Err(folio_core::CoreError::NotFound(root.to_string()));
    }
    // 「打开文件夹」= 切换到这个库（v4 单库策略）：先关掉其它库根（其成员降级为仅最近打开），
    // 再落新的 roots，保证扫描过程中任何按库根判定的路径（save 回退 / 前端判定）看到的都是新状态。
    let (prev_root, prev_demoted) = db.replace_root(&root)?;
    // FR-1.3：上限可配（settings.scanLimit），默认 2000；超出截断并**如实上报**（PERF-01：
    // 旧实现 found 被 max 截停，skipped=found−scanned 恒为 0，"超出上限"提示是句空话）
    let limit = db.settings()?.scan_limit.unwrap_or(SCAN_LIMIT);
    let (found, overflow) = fs::scan_dir_truncated(&rootp, limit);
    // P1-1：先取一次登记快照，再把「读盘 + 统计」全部放在 DB 锁外完成；
    // 最后 apply_scan 单事务落库，避免逐文件 autocommit 与逐文件重新 prepare。
    let snapshot = db.scan_snapshot()?;
    let mut writes: Vec<DocUpsert> = Vec::new();
    let mut mark_in_library: Vec<i64> = Vec::new();
    let mut inserted = 0usize;
    let mut updated = 0usize;
    let mut unchanged = 0usize;
    let mut scanned: HashSet<String> = HashSet::new();
    for p in &found {
        let key = p.to_string_lossy().to_lowercase();
        let disk_mtime = fs::mtime_secs(p);
        let disk_size = fs::file_size(p);
        // 增量：mtime+size 与登记一致 → 跳过重读重算（NFR-4）
        if let Some(existing) = snapshot.get(&key) {
            if existing.mtime == disk_mtime && existing.size == disk_size {
                // 内容没变但此前只是「单开文件」（在历史里、不在库里）：扫描=入库，补记归属即可，
                // 不必重读正文重算 FTS。否则用户登记了目录却看不到里面的文件进库。
                if !existing.in_library && !existing.builtin {
                    mark_in_library.push(existing.id);
                }
                scanned.insert(key);
                unchanged += 1;
                continue;
            }
            let Ok(src) = fs::read_md(p) else { continue };
            writes.push(DocUpsert::new(p, src, true, false));
            scanned.insert(key);
            updated += 1;
        } else {
            let Ok(src) = fs::read_md(p) else { continue };
            writes.push(DocUpsert::new(p, src, true, false));
            scanned.insert(key);
            inserted += 1;
        }
    }
    // skipped 语义收敛为"发现但读失败"；截断量单列 truncated，不再混在一个数里
    let skipped = found.len().saturating_sub(scanned.len());
    let removed = db.apply_scan(&rootp, &writes, &mark_in_library, &scanned)?;
    invalidate_search_cache(None); // 扫描可能更新/删除了正文：短查询片段缓存整体作废
    Ok(ScanReport {
        root: root.to_string(), total: found.len() + overflow, inserted, updated, removed, skipped, unchanged,
        prev_root, prev_demoted, truncated: overflow,
    })
}

pub fn search(db: &Arc<Db>, q: &SearchQuery) -> Result<Vec<SearchHit>> {
    let Some(p) = plan(&q.text) else { return Ok(Vec::new()) };
    let limit = q.limit.unwrap_or(DEFAULT_HIT_LIMIT).max(1);
    let mut hits: Vec<SearchHit> = Vec::new();

    match q.scope {
        SearchScope::Current => {
            let Some(id) = q.doc_id else { return Ok(Vec::new()) };
            let meta = db.doc_by_id(id)?;
            // 前端持有当前正文时优先用它：零读盘，且包含未保存的任务勾选/编辑缓冲
            let src: String = match q.src.as_deref() {
                Some(s) => s.to_string(),
                None => {
                    let Ok(s) = fs::read_md(Path::new(&meta.path)) else {
                        // 索引在、文件没了：静默空结果（正式版这里应顺手清索引）
                        return Ok(Vec::new());
                    };
                    s
                }
            };
            hits = folio_search::hits_for_doc(meta.id, &meta.path, &meta.title, &src, &q.text, limit as usize);
        }
        SearchScope::Library => {
            let ids = match &p {
                Plan::Fts { match_expr } => db.search_doc_ids(Some(match_expr), None, SEARCH_DOC_CANDIDATES)?,
                // 1–2 字：先按字符位图预筛候选，避免 LIKE 全库正文；位图不支持时回退原 LIKE
                Plan::Like { pattern, needle } => match db.search_short_doc_ids(needle, SEARCH_DOC_CANDIDATES)? {
                    Some(ids) => ids,
                    None => db.search_doc_ids(None, Some(pattern), SEARCH_DOC_CANDIDATES)?,
                },
            };
            for id in ids {
                if hits.len() >= limit as usize {
                    break;
                }
                let Ok(meta) = db.doc_by_id(id) else { continue };
                let room = limit as usize - hits.len();
                // 分节缓存命中 → 不再读盘/重新分节；miss 时现读（单点真相仍是磁盘，戳由 metadata 校验）
                if let Some(secs) = cached_sections(&meta) {
                    hits.extend(folio_search::hits_for_sections(
                        meta.id, &meta.path, &meta.title, &secs, &q.text, room,
                    ));
                } else {
                    let Ok(src) = fs::read_md(Path::new(&meta.path)) else { continue };
                    hits.extend(folio_search::hits_for_doc(meta.id, &meta.path, &meta.title, &src, &q.text, room));
                }
            }
        }
    }
    Ok(hits)
}

pub fn save_position(db: &Arc<Db>, doc_id: i64, p: &Position) -> Result<()> {
    db.save_position(doc_id, p)
}

/// 词法规范化 base + rel（处理 ./ ../ 与混合分隔符，不触盘）
fn normalize_join(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for comp in rel.split(['/', '\\']) {
        match comp {
            "" | "." => {}
            ".." => {
                p.pop();
            }
            c => p.push(c),
        }
    }
    p
}

/// 只把"看起来是图片"的扩展名解析进 asset 白名单（SEC-05：非图片文件即便存在也不放行，
/// 压缩任意本机文件被投喂为 <img> 的可能；同时拒绝协议相对 // 这类伪本地写法）。
const IMG_EXTS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];

fn is_img_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMG_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 本地图片资源解析（FR-2.1 补全）：md 里的相对/根绝对路径相对"文档位置"解析。
/// 候选策略：从文档目录逐级上探到盘根——
///   · `/assets/x.png` 型 = 仓库根语义（文档站在任意深度都能命中项目根的 assets/）
///   · `./img.png`、`../img.png` 型 = 先按文档目录拼接，再向上探（容忍非标准写法）
/// 网络协议与 data: 交由前端直连，返回 None。
pub fn resolve_image(doc_path: &str, url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() || u.contains("://") || u.starts_with("//")
        || u.starts_with("data:") || u.starts_with("mailto:")
    {
        return None; // "//host/x" 是协议相对远程图，不触盘（SEC-04 同口径）
    }
    let doc = Path::new(doc_path);
    let mut cur = doc.parent().map(|p| p.to_path_buf())?;
    let lead = u.starts_with('/') || u.starts_with('\\');
    let rel = u.trim_start_matches(['/', '\\']);
    loop {
        let cand = if lead {
            if rel.is_empty() { return None; }
            cur.join(rel)
        } else {
            normalize_join(&cur, u)
        };
        if cand.is_file() {
            // 命中即终判：不是图片扩展名就停（继续上探只会扩大存在性探测面）
            return if is_img_ext(&cand) { Some(cand.to_string_lossy().into_owned()) } else { None };
        }
        if !cur.pop() {
            return None; // 到盘根仍未命中
        }
    }
}

/* ── FR-13.1 导出 HTML 图片随行（需求方 2026-11-17：页面内所有图片资源随页面一同导出，
 * 统一存放到 HTML 文件同级目录的 images/ 下）。
 * kind="file"=本地磁盘绝对路径（Reader 水合留痕 data-folio-local）；kind="url"=http(s) 直下。
 * 下载放 Rust 侧：webview CSP 的 connect-src 只放行 IPC，前端 fetch 远程图必被拦。
 * 单图失败只标记它自己（name=None，前端保留原 src 兜底），不中断整次导出。 */
#[derive(serde::Deserialize)]
pub struct ImageRef {
    pub source: String,
    pub kind: String, // "file" | "url"
}
#[derive(serde::Serialize)]
pub struct ImageOut {
    pub source: String,
    pub name: Option<String>, // None = 落盘失败
}

/// 单图字节上限（32MB）——正常图片远小于此，超限多半是错引或恶意路径。
const MAX_EXPORT_IMG_BYTES: u64 = 32 * 1024 * 1024;

/// 源地址 → 安全文件名：取路径/URL 末段，URL 先剥 query/fragment 再 percent-decode；
/// Windows 非法字符与控制符剔除，超 80 字符截断（保住扩展名）。
fn image_base_name(source: &str, kind: &str) -> String {
    let raw = if kind == "url" {
        let cut = source.split(['?', '#']).next().unwrap_or(source);
        let seg = cut.rsplit('/').next().unwrap_or(cut);
        urlencoding::decode(seg).map(|c| c.into_owned()).unwrap_or_else(|_| seg.to_string())
    } else {
        Path::new(source)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .map(|c| if (c as u32) < 0x20 || c == '/' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(&['.', ' '][..]).to_string();
    if trimmed.is_empty() {
        return "image".into();
    }
    if trimmed.chars().count() <= 80 {
        return trimmed;
    }
    let (stem, ext) = split_name_ext(&trimmed);
    let mut s: String = stem.chars().take(60).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() { s = "image".into(); }
    join_name(&s, &ext)
}

/// 拆（干，扩展）；扩展名须为 1~6 位字母数字，否则视为无扩展（不把脏尾巴带进文件系统）。
fn split_name_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => {
            let ext = &name[i + 1..];
            if !ext.is_empty() && ext.len() <= 6 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                (name[..i].to_string(), ext.to_string())
            } else {
                (name.to_string(), String::new())
            }
        }
        _ => (name.to_string(), String::new()),
    }
}

fn join_name(stem: &str, ext: &str) -> String {
    if ext.is_empty() { stem.to_string() } else { format!("{stem}.{ext}") }
}

/// 给每个去重后的源分配唯一目标文件名：同源复用同名；同名不同源→后来者加 8 位哈希后缀。
/// 纯函数、DOM 序即入参序 → 导出结果确定可单测。
pub fn plan_image_names(items: &[ImageRef]) -> HashMap<String, String> {
    let mut by_src: HashMap<String, String> = HashMap::new();
    let mut used: HashSet<String> = HashSet::new();
    for it in items {
        if by_src.contains_key(&it.source) {
            continue;
        }
        let base = image_base_name(&it.source, &it.kind);
        let name = if used.insert(base.clone()) {
            base
        } else {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            it.source.hash(&mut h);
            let tag = format!("{:08x}", h.finish() & 0xffff_ffff);
            let (stem, ext) = split_name_ext(&base);
            let mut cand = join_name(&format!("{stem}_{tag}"), &ext);
            let mut n = 1;
            while !used.insert(cand.clone()) {
                n += 1;
                cand = join_name(&format!("{stem}_{tag}_{n}"), &ext);
            }
            cand
        };
        by_src.insert(it.source.clone(), name);
    }
    by_src
}

/// 执行图片随行。本地复制与远程下载都走 tokio::fs/reqwest（不占执行器线程，等价 spawn_blocking
/// 契约）；远程并发、单请求 15s 超时。返回按去重源逐条的落盘结果。
pub async fn run_export_images(html_path: &Path, items: Vec<ImageRef>) -> Vec<ImageOut> {
    let mut uniq: Vec<&ImageRef> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for it in &items {
        if seen.insert(it.source.as_str()) {
            uniq.push(it);
        }
    }
    let dir = html_path.parent().unwrap_or(Path::new(".")).join("images");
    let names = plan_image_names(&items);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return uniq
            .into_iter()
            .map(|it| ImageOut { source: it.source.clone(), name: None })
            .collect();
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Folio/1.0")
        .build()
        .ok();
    let mut out = Vec::new();
    let mut handles = Vec::new();
    for it in uniq {
        let Some(name) = names.get(&it.source).cloned() else { continue };
        if it.kind == "url" {
            let (src, dst_dir) = (it.source.clone(), dir.clone());
            let Some(c) = client.clone() else {
                out.push(ImageOut { source: src, name: None });
                continue;
            };
            handles.push(tokio::spawn(async move {
                let mut ok_name: Option<String> = None;
                if let Ok(resp) = c.get(&src).send().await {
                    if resp.status().is_success() {
                        let too_big = resp.content_length().map(|l| l > MAX_EXPORT_IMG_BYTES).unwrap_or(false);
                        if !too_big {
                            if let Ok(bytes) = resp.bytes().await {
                                if (bytes.len() as u64) <= MAX_EXPORT_IMG_BYTES
                                    && tokio::fs::write(dst_dir.join(&name), &bytes).await.is_ok()
                                {
                                    ok_name = Some(name);
                                }
                            }
                        }
                    }
                }
                ImageOut { source: src, name: ok_name }
            }));
        } else {
            let src = PathBuf::from(&it.source);
            let dst = dir.join(&name);
            let mut res: Option<String> = None;
            if let Ok(m) = tokio::fs::metadata(&src).await {
                if m.is_file() && m.len() <= MAX_EXPORT_IMG_BYTES {
                    if let Ok(bytes) = tokio::fs::read(&src).await {
                        if tokio::fs::write(&dst, &bytes).await.is_ok() {
                            res = Some(name);
                        }
                    }
                }
            }
            out.push(ImageOut { source: it.source.clone(), name: res });
        }
    }
    for h in handles {
        if let Ok(o) = h.await {
            out.push(o);
        } // join 失败（panic/取消）视作落盘失败：前端按缺键兜底保留原链
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_file_name_vectors() {
        // 与 tests/filename.test.ts 逐条镜像——改一侧必双跑
        assert_eq!(validate_file_name(" 报告.md ").unwrap(), "报告.md");
        assert!(matches!(validate_file_name("   "), Err(folio_core::CoreError::Invalid(c)) if c == "EMPTY"));
        assert!(matches!(validate_file_name("a/b.md"), Err(folio_core::CoreError::Invalid(c)) if c == "ILLEGAL_CHARS"));
        assert!(matches!(validate_file_name("a:b.md"), Err(folio_core::CoreError::Invalid(c)) if c == "ILLEGAL_CHARS"));
        assert!(matches!(validate_file_name("尾点."), Err(folio_core::CoreError::Invalid(c)) if c == "BAD_END"));
        assert!(validate_file_name("名 字.md").is_ok(), "中间空格合法");
        assert!(matches!(validate_file_name("名字. "), Err(folio_core::CoreError::Invalid(c)) if c == "BAD_END"), "尾随空格先 trim，剩下句点结尾仍非法");
        assert!(matches!(validate_file_name("bad?.md"), Err(folio_core::CoreError::Invalid(c)) if c == "ILLEGAL_CHARS"));
        assert!(matches!(validate_file_name("noext"), Err(folio_core::CoreError::Invalid(c)) if c == "BAD_EXT"));
        assert!(matches!(validate_file_name("photo.PNG"), Err(folio_core::CoreError::Invalid(c)) if c == "BAD_EXT"));
        assert!(validate_file_name("a.MD").is_ok());
        assert!(validate_file_name("x.txt").is_ok());
        let long = "名".repeat(252) + ".md";
        assert!(validate_file_name(&long).is_ok());
        let too_long = "名".repeat(253) + ".md";
        assert!(matches!(validate_file_name(&too_long), Err(folio_core::CoreError::Invalid(c)) if c == "TOO_LONG"));
    }

    #[test]
    fn rename_moves_file_and_row_but_keeps_id() {
        let dir = std::env::temp_dir().join("folio-cmd-rename");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(Db::open(&dir.join("f.db")).unwrap());
        let old = dir.join("甲.md");
        std::fs::write(&old, "# 标题甲\n\n正文").unwrap();
        let m0 = db.upsert_document(&old, "# 标题甲\n\n正文", true).unwrap();

        let m1 = rename(&db, &old.to_string_lossy(), "乙.md").unwrap();
        assert_eq!(m1.id, m0.id, "doc_id 原地不动");
        assert_eq!(m1.file_name, "乙.md");
        assert_eq!(m1.title, "标题甲", "首行 H1 是标题来源，改名不许动它");
        assert!(!old.exists() && dir.join("乙.md").exists(), "磁盘文件已改名");
        assert!(db.doc_by_path(&m1.path).is_ok() && db.doc_by_path(&old.to_string_lossy()).is_err());

        // 失败面：校验拒绝 / 重名拒绝 / 失败后原名原样（验收「不产生半完成状态」）
        assert!(rename(&db, &m1.path, "").is_err());
        assert!(rename(&db, &m1.path, "bad/name.md").is_err());
        assert!(rename(&db, &m1.path, "noext").is_err());
        std::fs::write(dir.join("已存在.md"), "x").unwrap();
        assert!(matches!(
            rename(&db, &m1.path, "已存在.md"),
            Err(folio_core::CoreError::Invalid(c)) if c == "EXISTS"
        ));
        assert!(dir.join("乙.md").exists() && dir.join("已存在.md").exists(), "失败保留原名");

        // 大小写改名（同文件）：不判重名，形态落库
        let m2 = rename(&db, &m1.path, "乙.MD").unwrap();
        assert_eq!(m2.file_name, "乙.MD");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_dir_name_vectors() {
        // 与 tests/filename.test.ts 目录段镜像
        assert_eq!(validate_dir_name(" 备份 2024 ").unwrap(), "备份 2024");
        assert!(validate_dir_name("笔记.2024").is_ok(), "目录名中段句点合法，且没有扩展名规则");
        assert!(matches!(validate_dir_name("   "), Err(folio_core::CoreError::Invalid(c)) if c == "EMPTY"));
        assert!(matches!(validate_dir_name("a:b"), Err(folio_core::CoreError::Invalid(c)) if c == "ILLEGAL_CHARS"));
        assert!(matches!(validate_dir_name("尾点."), Err(folio_core::CoreError::Invalid(c)) if c == "BAD_END"));
        let too_long = "目".repeat(256);
        assert!(matches!(validate_dir_name(&too_long), Err(folio_core::CoreError::Invalid(c)) if c == "TOO_LONG"));
    }

    #[test]
    fn rename_dir_moves_subtree_and_roots() {
        let base = std::env::temp_dir().join("folio-cmd-renamedir");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let sub = base.join("笔记");
        std::fs::create_dir_all(sub.join("子")).unwrap();
        std::fs::write(sub.join("a.md"), "# A").unwrap();
        std::fs::write(sub.join("子").join("b.md"), "# B").unwrap();
        let db = Arc::new(Db::open(&base.join("f.db")).unwrap());
        let ma = db.upsert_document(&sub.join("a.md"), "# A", true).unwrap();
        db.upsert_document(&sub.join("子").join("b.md"), "# B", true).unwrap();
        db.add_root(&sub.to_string_lossy()).unwrap();

        // 撞名拒绝且现场不动
        std::fs::create_dir(base.join("占用")).unwrap();
        assert!(matches!(
            rename_dir(&db, &sub.to_string_lossy(), "占用"),
            Err(folio_core::CoreError::Invalid(c)) if c == "EXISTS"
        ));
        assert!(sub.join("a.md").exists());

        // 成功：磁盘子树 + 文档路径 + 库根一起换前缀；id/slug 不动
        let newp = rename_dir(&db, &sub.to_string_lossy(), "新笔记").unwrap();
        let newsub = base.join("新笔记");
        assert_eq!(newp, newsub.to_string_lossy());
        assert!(newsub.join("a.md").exists() && newsub.join("子").join("b.md").exists());
        assert!(!sub.exists(), "旧目录不许残留");
        let mb = db.doc_by_path(&newsub.join("a.md").to_string_lossy()).unwrap();
        assert_eq!(mb.id, ma.id, "doc_id 原地不动");
        assert_eq!(mb.slug, ma.slug, "slug 不随目录名变");
        assert_eq!(mb.dir, newsub.to_string_lossy(), "dir 同步换前缀");
        let roots = db.list_roots().unwrap();
        assert!(roots.iter().any(|r| r.to_lowercase() == newp.to_lowercase()), "库根登记跟走：{roots:?}");
        assert_eq!(db.list_docs().unwrap().len(), 2);
        assert!(db.doc_by_path(&newsub.join("子").join("b.md").to_string_lossy()).is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn plan_image_names_dedups_and_disambiguates() {
        let mk = |s: &str, k: &str| ImageRef { source: s.into(), kind: k.into() };
        let items = vec![
            mk("C:\\docs\\a\\pic.png", "file"),
            mk("C:\\docs\\b\\pic.png", "file"),          // 同名不同源 → 后缀消歧
            mk("C:\\docs\\a\\pic.png", "file"),          // 同源重复引用 → 复用同名
            mk("https://ex.com/x/pic.png?v=2", "url"),   // 剥 query 后又撞 pic.png → 再消歧
            mk("https://ex.com/dir/", "url"),            // 无名可取 → 兜底 image
        ];
        let plan = plan_image_names(&items);
        assert_eq!(plan.len(), 4, "同源只算一条");
        assert_eq!(plan["C:\\docs\\a\\pic.png"], "pic.png");
        let b = &plan["C:\\docs\\b\\pic.png"];
        assert!(b.starts_with("pic_") && b.ends_with(".png") && b != "pic.png", "{b}");
        let u = &plan["https://ex.com/x/pic.png?v=2"];
        assert!(u.starts_with("pic_") && u.ends_with(".png") && u != b && u != "pic.png", "{u}");
        assert_eq!(&plan["https://ex.com/dir/"], "image");
        let set: HashSet<&String> = plan.values().collect();
        assert_eq!(set.len(), plan.len(), "全部互不相同");
    }

    #[test]
    fn image_base_name_sanitizes_decodes_and_truncates() {
        // Windows 非法字符剔除
        assert_eq!(image_base_name("C:\\a\\b<img>:x?.png", "file"), "bimgx.png");
        // 尾点/空格修剪（Windows 会静默吃掉）
        assert_eq!(image_base_name("C:\\a\\x. . ", "file"), "x");
        assert_eq!(image_base_name("C:\\a\\..", "file"), "image");
        // URL：剥 query/fragment + percent-decode + 斜杠不残留
        assert_eq!(image_base_name("https://ex.com/%E5%9B%BE%201.png#a?b", "url"), "图 1.png");
        // 超长截断但保住扩展名
        let long = format!("{}.png", "あ".repeat(100));
        let n = image_base_name(&format!("C:\\d\\{long}"), "file");
        assert!(n.chars().count() <= 65 && n.ends_with(".png"), "{n}");
    }

    #[test]
    fn export_images_copies_local_and_reports() {
        let base = std::env::temp_dir().join(format!("folio-eimg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.png"), [1u8, 2, 3]).unwrap();
        let html = base.join("out.html");
        let items = vec![
            ImageRef { source: base.join("a.png").to_string_lossy().into_owned(), kind: "file".into() },
            ImageRef { source: base.join("gone.png").to_string_lossy().into_owned(), kind: "file".into() },
        ];
        let outs = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_export_images(&html, items));
        let by: HashMap<_, _> = outs.iter().map(|o| (o.source.clone(), o.name.clone())).collect();
        assert_eq!(by[&base.join("a.png").to_string_lossy().into_owned()].as_deref(), Some("a.png"));
        assert!(base.join("images").join("a.png").exists(), "图真落盘");
        assert_eq!(std::fs::read(base.join("images").join("a.png")).unwrap(), [1u8, 2, 3]);
        assert!(by[&base.join("gone.png").to_string_lossy().into_owned()].is_none(), "死图报失败");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn root_style_url_finds_repo_assets_via_ancestor_walk() {
        let base = std::env::temp_dir().join(format!("folio-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("assets/images")).unwrap();
        std::fs::create_dir_all(base.join("docs/plans")).unwrap();
        let img = base.join("assets/images/tux.png");
        std::fs::write(&img, "PNG").unwrap();
        let doc = base.join("docs/plans/p.md");
        std::fs::write(&doc, "# p\n\n![Tux](/assets/images/tux.png)\n").unwrap();

        let got = resolve_image(doc.to_str().unwrap(), "/assets/images/tux.png").unwrap();
        assert_eq!(Path::new(&got), img.as_path());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn relative_urls_resolve_against_doc_dir_then_ancestors() {
        let base = std::env::temp_dir().join(format!("folio-img2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("docs/plans/img")).unwrap();
        std::fs::create_dir_all(base.join("docs/assets")).unwrap();
        let near = base.join("docs/plans/img/a.png");
        std::fs::write(&near, "A").unwrap();
        let up = base.join("docs/assets/b.png");
        std::fs::write(&up, "B").unwrap();
        let doc = base.join("docs/plans/p.md");
        std::fs::write(&doc, "# p\n").unwrap();

        assert!(resolve_image(doc.to_str().unwrap(), "./img/a.png").is_some());
        assert!(resolve_image(doc.to_str().unwrap(), "../assets/b.png").is_some());
        // 未命中 → None（不 panic、不放行）
        assert_eq!(resolve_image(doc.to_str().unwrap(), "nope.png"), None);
        assert_eq!(resolve_image(doc.to_str().unwrap(), "https://x.cn/a.png"), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn normalize_scan_root_pads_bare_drive() {
        // 毒路径源头守卫：裸盘符必须补分隔符，其余形态一律不动
        assert_eq!(normalize_scan_root("D:"), "D:\\");
        assert_eq!(normalize_scan_root("d:"), "d:\\");
        assert_eq!(normalize_scan_root("D:\\"), "D:\\");
        assert_eq!(normalize_scan_root("D:\\docs"), "D:\\docs");
        assert_eq!(normalize_scan_root("\\\\srv\\share"), "\\\\srv\\share");
        assert_eq!(normalize_scan_root("/srv"), "/srv");
    }

    #[test]
    fn resolve_image_blocks_non_images_and_protocol_relative() {
        // SEC-05：非图片扩展名即便存在也不解析（不产存在性 oracle、不进 asset 白名单）；
        // 协议相对 // 是远程写法，不触盘（SEC-04 同口径）。
        let base = std::env::temp_dir().join(format!("folio-img3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "sensitive").unwrap();
        let doc = base.join("d.md");
        std::fs::write(&doc, "# d\n").unwrap();
        assert_eq!(resolve_image(doc.to_str().unwrap(), "secret.txt"), None);
        assert_eq!(resolve_image(doc.to_str().unwrap(), "//evil.example/x.png"), None);
        assert_eq!(resolve_image(doc.to_str().unwrap(), "\\\\evil\\share\\x.png"), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
