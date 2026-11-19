//! folio-db — 唯一持有 SQLite 连接（Mutex 包装，命令层并发安全）。
//! 表设计沿用原型 localStorage 语义：documents(+fts) / positions(每文档) / settings(blob)。

mod charbits;
mod schema;

use folio_core::{markdown, CoreError, DocMeta, Position, RecentDoc, RecentReport, Result, Settings};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 写连接 + 只读连接分离（性能评审 P1-1）：
/// 扫描/保存用写连接，列表/搜索/设置走只读连接；WAL 下读连接不会被写事务挡住，
/// 大库扫描期间侧栏、设置、位置读取不再排队等同一把锁。
/// 只读连接显式 `query_only=ON`，任何误走读连接的写会立即报错而不是悄悄分叉。
pub struct Db {
    conn: Mutex<Connection>,
    read: Mutex<Connection>,
}

/// 扫描快照行：调用方在文件系统遍历阶段用它判断「未变/要更新/新增」，避免逐文件回 DB 取 meta。
#[derive(Debug, Clone)]
pub struct ScanRow {
    pub id: i64,
    pub mtime: i64,
    pub size: u64,
    pub in_library: bool,
    pub builtin: bool,
}

/// 待写文档（扫描批量入库用）：统计/标题/文件元数据都在锁外算好，
/// 事务内只做 SQL + FTS 写入，尽量缩短写锁持有时长。
pub struct DocUpsert {
    pub path: PathBuf,
    pub src: String,
    pub in_library: bool,
    pub builtin: bool,
    pub title: String,
    pub file_name: String,
    pub dir: String,
    pub word_count: i64,
    pub head_count: i64,
    pub sec_count: i64,
    pub mtime: i64,
    pub size: u64,
    /// 1–2 字短查询预筛位图（65536 位；锁外算好，事务内只写 BLOB）
    pub bitmap: Vec<u8>,
}

impl DocUpsert {
    pub fn new(path: &Path, src: String, in_library: bool, builtin: bool) -> Self {
        let path_str = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let bitmap = charbits::bitmap(&src);
        let (word_count, head_count, sec_count) = markdown::stats(&src);
        let meta_fs = std::fs::metadata(path).ok();
        let mtime = meta_fs
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta_fs.map(|m| m.len()).unwrap_or(0);
        let title = src
            .lines()
            .find_map(|l| {
                let t = l.trim_start();
                t.strip_prefix("# ").map(|s| s.trim().to_string())
            })
            .unwrap_or_else(|| markdown::slugify(&file_name));
        DocUpsert {
            path: path.to_path_buf(),
            src,
            in_library,
            builtin,
            title,
            file_name,
            dir,
            word_count,
            head_count,
            sec_count,
            mtime,
            size,
            bitmap,
        }
    }
}

/// LIKE 模式转义（% _ \），与 `ESCAPE '\'` 连用；口径同 folio-search::plan 的 LIKE 分支。
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| CoreError::Db(e.to_string()))?;
        }
        let conn = Connection::open(path).map_err(|e| CoreError::Db(e.to_string()))?;
        // 迁移/建表先在写连接上跑完，再开只读连接——保证读连接从第一眼起看到的就是
        // WAL 模式与完整 schema，不存在「先以旧 journal 打开、之后才切 WAL」的窗口。
        schema::setup(&conn).map_err(|e| CoreError::Db(e.to_string()))?;
        let read = Connection::open(path).map_err(|e| CoreError::Db(e.to_string()))?;
        let db = Db { conn: Mutex::new(conn), read: Mutex::new(read) };
        // 读连接只读：防止未来误把写方法接到读连接上造成两套连接分叉；
        // busy_timeout 让 WAL checkpoint 瞬间的短暂占用自动等待，而不是立刻报 BUSY。
        db.with_read(|c| {
            c.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;")
        })?;
        Ok(db)
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::Internal(format!("db mutex: {e}")))?;
        f(&guard).map_err(|e| CoreError::Db(e.to_string()))
    }

    fn with_read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let guard = self
            .read
            .lock()
            .map_err(|e| CoreError::Internal(format!("db read mutex: {e}")))?;
        f(&guard).map_err(|e| CoreError::Db(e.to_string()))
    }

    /// 单事务写：扫描批量入库、库根切换、历史清理都走这里。
    /// 事务内仍可 `prepare_cached` 复用语句；提交一次 = 一次 fsync 级别的落盘。
    fn with_tx<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction) -> rusqlite::Result<T>,
    ) -> Result<T> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::Internal(format!("db mutex: {e}")))?;
        let tx = guard
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| CoreError::Db(e.to_string()))?;
        let out = f(&tx).map_err(|e| CoreError::Db(e.to_string()))?;
        tx.commit().map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(out)
    }

    /// 登记/更新一个文档（绝对路径为自然键；重扫=upsert，slug 稳定不跳）。
    /// `in_library` 由调用方决定：扫描登记=true；打开单个文件=v3 起的 `library_membership`
    /// （不在已登记库根之下即为 false，只进「最近打开」）。
    pub fn upsert_document(&self, path: &Path, src: &str, in_library: bool) -> Result<DocMeta> {
        self.upsert_inner(path, src, in_library, false)
    }

    /// 内置文档登记（欢迎页等）：既不入库，也不被「清空最近打开」回收
    pub fn upsert_builtin_document(&self, path: &Path, src: &str) -> Result<DocMeta> {
        self.upsert_inner(path, src, false, true)
    }

    fn upsert_inner(
        &self,
        path: &Path,
        src: &str,
        in_library: bool,
        builtin: bool,
    ) -> Result<DocMeta> {
        let path_str = path.to_string_lossy().to_string();
        // 统计/标题/元数据在写锁外算好；锁内只做 SQL（与扫描批量同一路径）
        let doc = DocUpsert::new(path, src.to_string(), in_library, builtin);
        self.with_tx(|c| upsert_prepared(c, &doc))?;
        self.doc_by_path(&path_str)
    }

    /// 扫描快照：一次读出全部登记行的增量判据（锁外遍历时用）。
    /// 键 = 小写路径，与扫描侧 `to_string_lossy().to_lowercase()` 同口径。
    pub fn scan_snapshot(&self) -> Result<std::collections::HashMap<String, ScanRow>> {
        self.with_read(|c| {
            let mut st = c.prepare("SELECT id, path, mtime, size, in_library, builtin FROM documents")?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?.to_lowercase(),
                    ScanRow {
                        id: r.get(0)?,
                        mtime: r.get(2)?,
                        size: r.get::<_, i64>(3)? as u64,
                        in_library: r.get::<_, i64>(4)? != 0,
                        builtin: r.get::<_, i64>(5)? != 0,
                    },
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// 扫描结果一次事务落库（P1-1）：
    ///   ① 批量 upsert（新增/更新，语句预编译复用）；
    ///   ② 未变但此前只是「单开文件」的条目补记库归属；
    ///   ③ 库根下未扫到的条目一次性 purge。
    /// 返回移除条数。文件读盘/统计都在调用方锁外完成，事务只持有 SQL 与 FTS 写入所需时间。
    pub fn apply_scan(
        &self,
        root: &Path,
        writes: &[DocUpsert],
        mark_in_library: &[i64],
        scanned: &HashSet<String>,
    ) -> Result<usize> {
        self.with_tx(|c| {
            for d in writes {
                upsert_prepared(c, d)?;
            }
            {
                let mut st = c.prepare_cached("UPDATE documents SET in_library = 1 WHERE id = ?1")?;
                for id in mark_in_library {
                    st.execute(params![id])?;
                }
            }
            let root_str = root.to_string_lossy().into_owned();
            let rows: Vec<(i64, String)> = {
                let mut st = c.prepare("SELECT id, path FROM documents WHERE in_library = 1")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut removed = 0usize;
            for (id, path) in rows {
                let p = path.to_lowercase();
                if !schema::path_under(&path, &root_str) || scanned.contains(&p) {
                    continue;
                }
                purge_conn(c, id)?;
                removed += 1;
            }
            Ok(removed)
        })
    }

    /// P1-6：WAL checkpoint（TRUNCATE）：回收后清空 -wal 文件；由启动空闲后的后台维护线程调用
    pub fn checkpoint(&self) -> Result<()> {
        self.with_conn(|c| {
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                let _busy: i64 = row.get(0)?;
                Ok(())
            })?;
            Ok(())
        })
    }

    /// P1-6 补：FTS5 段再合并。整批移除文档后，fts5 索引 b 树留下大量未合并段碎片
    /// （实测 167KB 正文被 14.7MB 陈旧段包裹）；VACUUM 不处理这类"活数据"，必须先 optimize。
    /// 触发条件保守：索引块总量 >1MB 且 >8× 正文字节——正常 trigram 比约 4:1，命中即碎片级。
    pub fn optimize_fts_if_stale(&self) -> Result<()> {
        self.with_conn(|c| {
            let body: i64 =
                c.query_row("SELECT coalesce(sum(length(body)),0) FROM docs_fts", [], |r| r.get(0))?;
            let blocks: i64 = c
                .query_row("SELECT coalesce(sum(length(block)),0) FROM docs_fts_data", [], |r| r.get(0))
                .unwrap_or(0);
            if blocks > 1_048_576 && blocks > body.saturating_mul(8) {
                c.execute("INSERT INTO docs_fts(docs_fts) VALUES('optimize')", [])?;
            }
            Ok(())
        })
    }

    /// P1-6：空闲页 >1000 且占库 1/4 以上时做一次 VACUUM；清完即不再触发。
    /// 阈值取 1/4 的缘由：整批移除库根（如换文档目录）会留下 40% 级 freelist，
    /// 若仍要求"过半"则长期不回收。
    pub fn vacuum_if_bloated(&self) -> Result<()> {
        self.with_conn(|c| {
            let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
            let free: i64 = c.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
            if free > 1024 && free * 4 >= pages {
                c.execute("VACUUM", [])?;
            }
            Ok(())
        })
    }

    pub fn doc_by_path(&self, path: &str) -> Result<DocMeta> {
        self.query_doc("SELECT * FROM documents WHERE path = ?1 COLLATE NOCASE", path)?
            .ok_or_else(|| CoreError::NotFound(path.to_string()))
    }

    pub fn doc_by_slug(&self, slug: &str) -> Result<DocMeta> {
        self.query_doc("SELECT * FROM documents WHERE slug = ?1", slug)?
            .ok_or_else(|| CoreError::NotFound(format!("slug:{slug}")))
    }

    pub fn doc_by_id(&self, id: i64) -> Result<DocMeta> {
        self.with_read(|c| {
            c.query_row("SELECT * FROM documents WHERE id = ?1", params![id], row_to_meta)
                .optional()
        })?
        .ok_or_else(|| CoreError::NotFound(format!("id:{id}")))
    }

    fn query_doc(&self, sql: &str, key: &str) -> Result<Option<DocMeta>> {
        self.with_read(|c| c.query_row(sql, params![key], row_to_meta).optional())
    }

    pub fn list_docs(&self) -> Result<Vec<DocMeta>> {
        self.with_read(|c| {
            let mut st = c.prepare("SELECT * FROM documents ORDER BY mtime DESC, id ASC")?;
            let rows = st.query_map([], row_to_meta)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// 扫描同步：root 之下、in_library=1、且不在 scanned 集合中的条目删除（连带历史/位置/fts）。
    /// root 之外的条目（只进「最近打开」的文件、内置文档）不受影响。
    pub fn sync_library(&self, root: &Path, scanned: &HashSet<String>) -> Result<usize> {
        // CON-05：统一用 schema::path_under（带分隔符边界）。此前手写 `starts_with(prefix)`
        // 会让库根 D:/docs 把 D:/docs2/a.md 误判为库内条目而回收——与 library_membership 两套口径。
        let root_str = root.to_string_lossy().into_owned();
        self.with_tx(|c| {
            let rows: Vec<(i64, String)> = {
                let mut st = c.prepare("SELECT id, path FROM documents WHERE in_library = 1")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut removed = 0usize;
            for (id, path) in rows {
                let p = path.to_lowercase();
                if !schema::path_under(&path, &root_str) || scanned.contains(&p) {
                    continue;
                }
                purge_conn(c, id)?;
                removed += 1;
            }
            Ok(removed)
        })
    }

    /// 圈定候选文档 id：FTS(bm25) 或 LIKE。片段由命令层现读文件装配（单点真相=磁盘）。
    pub fn search_doc_ids(
        &self,
        fts_expr: Option<&str>,
        like: Option<&str>,
        limit: i64,
    ) -> Result<Vec<i64>> {
        self.with_read(|c| {
            if let Some(m) = fts_expr {
                let mut st = c.prepare(
                    "SELECT CAST(doc AS INTEGER) FROM docs_fts WHERE docs_fts MATCH ?1
                     ORDER BY bm25(docs_fts) LIMIT ?2",
                )?;
                return st.query_map(params![m, limit], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>();
            }
            if let Some(l) = like {
                // ESCAPE 字符用参数绑定：SQL 文本里写反斜杠字面量存在解析歧义
                // （实测报 "ESCAPE expression must be a single character"）
                let mut st = c.prepare(
                    "SELECT CAST(doc AS INTEGER) FROM docs_fts
                     WHERE body LIKE ?1 ESCAPE ?3 OR title LIKE ?1 ESCAPE ?3
                     ORDER BY rowid LIMIT ?2",
                )?;
                return st.query_map(params![l, limit, "\\"], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>();
            }
            Ok(Vec::new())
        })
    }

    /// 1–2 字短查询：按 doc_chars 位图预筛候选文档，避免 `body LIKE '%x%'` 全库扫描。
    /// `None` = 查询长度/字符超出位图范围（或表未就绪），调用方回退 LIKE。
    /// 候选只保证「字出现过」；顺序/完整词由命令层的精确 section 搜索继续验证。
    pub fn search_short_doc_ids(&self, needle: &str, limit: i64) -> Result<Option<Vec<i64>>> {
        let Some(chars) = charbits::query_chars(needle) else { return Ok(None) };
        self.with_read(|c| {
            let mut st = c.prepare("SELECT doc_id, bitmap FROM doc_chars ORDER BY doc_id")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
            let all: Vec<(i64, Vec<u8>)> = rows.collect::<rusqlite::Result<_>>()?;
            if all.is_empty() {
                // 无文档 = 合法空结果；有文档但位图表空 = 迁移未完成，回退 LIKE
                let docs: i64 = c.query_row("SELECT count(*) FROM documents", [], |r| r.get(0))?;
                return Ok(if docs == 0 { Some(Vec::new()) } else { None });
            }
            // 选命中文档最少的字做候选（两字查询取更稀有的那一个），再交给精确搜索
            let mut best: Option<(char, usize)> = None;
            for ch in &chars {
                let n = all.iter().filter(|(_, b)| charbits::has(b, *ch)).count();
                if best.map(|(_, bn)| n < bn).unwrap_or(true) {
                    best = Some((*ch, n));
                }
            }
            let Some((ch, _)) = best else { return Ok(Some(Vec::new())) };
            let ids = all
                .iter()
                .filter(|(_, b)| charbits::has(b, ch))
                .map(|(id, _)| *id)
                .take(limit.max(1) as usize)
                .collect();
            Ok(Some(ids))
        })
    }

    pub fn save_position(&self, doc_id: i64, p: &Position) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO positions(doc_id, ratio, sec, sec_text, sec_off, sec_line_off, updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(doc_id) DO UPDATE SET
                    ratio=?2, sec=?3, sec_text=?4, sec_off=?5, sec_line_off=?6, updated_at=?7",
                params![doc_id, p.ratio, p.sec, p.sec_text, p.sec_off, p.sec_line_off, p.updated_at],
            )?;
            Ok(())
        })
    }

    pub fn positions(&self) -> Result<Vec<(i64, Position)>> {
        self.with_read(|c| {
            let mut st =
                c.prepare("SELECT doc_id, ratio, sec, sec_text, sec_off, sec_line_off, updated_at FROM positions")?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    Position {
                        ratio: r.get(1)?,
                        sec: r.get(2)?,
                        sec_text: r.get(3)?,
                        sec_off: r.get(4)?,
                        sec_line_off: r.get(5)?,
                        updated_at: r.get(6)?,
                    },
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /* ── schema v2：置顶 / 库根管理 ── */

    /// 置顶（库列表的分组语义）。仅文档库成员可置顶——「最近打开」按时间排，不参与置顶。
    pub fn set_pinned(&self, id: i64, on: bool) -> Result<()> {
        self.with_conn(|c| {
            // 置顶只对库成员有意义（历史列表按时间排）。非库成员请求置顶 = 静默不生效；取消总允许。
            c.execute(
                "UPDATE documents SET pinned = ?1 WHERE id = ?2 AND (in_library = 1 OR ?1 = 0)",
                params![on as i64, id],
            )?;
            Ok(())
        })
    }

    /* ── schema v3：库成员 / 最近打开（两个概念互不隶属） ── */

    /// 库成员判定的唯一口径（v3 设计变更）：位于任一已登记库根之下，且不是内置文档。
    /// 「打开单个文件」不再入库，只记进「最近打开」。
    pub fn library_membership(&self, path: &Path) -> Result<bool> {
        let p = path.to_string_lossy().to_string();
        self.with_read(|c| {
            let builtin: i64 = c
                .query_row(
                    "SELECT builtin FROM documents WHERE path = ?1 COLLATE NOCASE",
                    params![p],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if builtin == 1 {
                return Ok(false);
            }
            let mut st = c.prepare("SELECT path FROM roots")?;
            let roots = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(roots.iter().any(|r| schema::path_under(&p, r)))
        })
    }

    /// 库成员开关：右键「从库移除」/（将来）「加入文档库」。登记行保留，出库时取消置顶。
    pub fn set_in_library(&self, id: i64, on: bool) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE documents SET in_library = ?1,
                    pinned = CASE WHEN ?1 = 0 THEN 0 ELSE pinned END
                 WHERE id = ?2",
                params![on as i64, id],
            )?;
            Ok(())
        })
    }

    /// 记一次打开（unix 秒）。同一文档重复打开只刷新时间，不产生第二条历史。
    pub fn record_recent(&self, doc_id: i64, at: i64) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO recents(doc_id, opened_at) VALUES(?1, ?2)
                 ON CONFLICT(doc_id) DO UPDATE SET opened_at = MAX(recents.opened_at, ?2)",
                params![doc_id, at],
            )?;
            Ok(())
        })
    }

    /// 打开历史：JOIN documents（历史不指向已消失的登记），时间倒序、同秒按 id 倒序。
    /// 需求方 2026-11-16：**按规范化路径去重，同一文件只保留最后一次打开**——
    /// 同一物理文件可能有多登记行（毒路径/斜杠形态的历史遗留），列表不许出现重复条目。
    pub fn list_recents(&self) -> Result<Vec<RecentDoc>> {
        let all: Vec<RecentDoc> = self.with_read(|c| {
            let mut st = c.prepare(
                "SELECT d.*, r.opened_at FROM recents r JOIN documents d ON d.id = r.doc_id
                 ORDER BY r.opened_at DESC, r.doc_id DESC",
            )?;
            let rows = st.query_map([], |r| {
                Ok(RecentDoc {
                    meta: row_to_meta(r)?,
                    opened_at: r.get::<_, i64>("opened_at")?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        // 输入已按 opened_at DESC：同一规范化路径的第一个即"最后一次打开"，后续同路径行丢弃
        let mut seen: HashSet<String> = HashSet::new();
        Ok(all
            .into_iter()
            .filter(|rd| {
                let key = schema::norm_path(&rd.meta.path);
                seen.insert(key) // insert==false 表示已见过 → 过滤掉
            })
            .collect())
    }

    /// 从历史移除一条。返回 true = 该登记行已失去归属（非库非内置），已连带回收。
    pub fn remove_recent(&self, doc_id: i64) -> Result<bool> {
        self.with_tx(|c| {
            c.execute("DELETE FROM recents WHERE doc_id = ?1", params![doc_id])?;
            let orphan: bool = c
                .query_row(
                    "SELECT in_library = 0 AND builtin = 0 FROM documents WHERE id = ?1",
                    params![doc_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0)
                == 1;
            if orphan {
                purge_conn(c, doc_id)?;
            }
            Ok(orphan)
        })
    }

    /// 清空打开历史：只删历史行；随后回收「既不在库也非内置」的登记行（连带进度与索引）。
    /// 库成员与内置文档的阅读进度不受影响；磁盘文件永不动。
    pub fn clear_recents(&self) -> Result<RecentReport> {
        self.with_tx(|c| {
            let cleared = c.execute("DELETE FROM recents", [])? as i64;
            let ids: Vec<i64> = {
                let mut st = c.prepare("SELECT id FROM documents WHERE in_library = 0 AND builtin = 0")?;
                let rows = st.query_map([], |r| r.get::<_, i64>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for id in &ids {
                purge_conn(c, *id)?;
            }
            Ok(RecentReport { cleared, pruned: ids.len() as i64 })
        })
    }

    /// 彻底删除一条登记（历史/进度/索引一并清除）；磁盘文件不动。
    /// 注意：这不是「从库移除」——后者是 `set_in_library(id, false)`。
    pub fn remove_doc(&self, id: i64) -> Result<()> {
        self.with_tx(|c| purge_conn(c, id))
    }

    /// 单库策略（v4 决议）：登记新库根之前，先关掉其它所有库根——其成员降级为「仅最近打开」。
    /// 从此 `roots` 最多一行。返回 (被关闭的旧根, 出库条数)。
    /// 只动归属标记：磁盘、登记行、索引、进度、历史都不碰。
    /// **只关旧、不提新**：新根之下已有登记的入库由调用方紧接着的扫描负责
    /// （`commands::scan` 的 unchanged 分支会补 `in_library`），所以本方法必须早于扫描调用。
    pub fn replace_root(&self, path: &str) -> Result<(Option<String>, usize)> {
        let keep = schema::norm_dir(path);
        self.with_tx(|c| {
            let rows: Vec<(i64, String)> = {
                let mut st = c.prepare("SELECT id, path FROM roots ORDER BY id")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut prev: Option<String> = None;
            let mut demoted = 0usize;
            for (id, rp) in rows {
                if schema::norm_dir(&rp) == keep {
                    continue;
                }
                c.execute("DELETE FROM roots WHERE id = ?1", params![id])?;
                let docs: Vec<(i64, String)> = {
                    let mut st = c.prepare(
                        "SELECT id, path FROM documents WHERE in_library = 1 AND builtin = 0",
                    )?;
                    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()?
                };
                for (did, dp) in &docs {
                    // 新旧根嵌套时，仍在新根之下的条目不降级——紧接着的扫描会把它们重新入库
                    if !schema::path_under(dp, &rp) || schema::path_under(dp, path) {
                        continue;
                    }
                    c.execute(
                        "UPDATE documents SET in_library = 0, pinned = 0 WHERE id = ?1",
                        params![did],
                    )?;
                    demoted += 1;
                }
                prev = Some(rp);
            }
            c.execute("INSERT OR IGNORE INTO roots(path) VALUES(?1)", params![path])?;
            Ok((prev, demoted))
        })
    }

    pub fn add_root(&self, path: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("INSERT OR IGNORE INTO roots(path) VALUES(?1)", params![path])?;
            Ok(())
        })
    }

    /// 移除库根，并把「只被这个根覆盖」的库成员一并出库（磁盘文件、阅读进度、打开历史都不动）。
    /// 目的：维护 v3 的不变量 `in_library ⇒ 位于某个已登记库根之下`，库树里就不会出现无根可挂的条目。
    /// 仍被其他库根覆盖的条目留在库里。返回出库条数。
    pub fn remove_root(&self, path: &str) -> Result<usize> {
        self.with_tx(|c| {
            c.execute("DELETE FROM roots WHERE path = ?1 COLLATE NOCASE", params![path])?;
            let others: Vec<String> = {
                let mut st = c.prepare("SELECT path FROM roots")?;
                let rows = st.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let docs: Vec<(i64, String)> = {
                let mut st = c.prepare("SELECT id, path FROM documents WHERE in_library = 1 AND builtin = 0")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut demoted = 0usize;
            for (id, p) in &docs {
                if others.iter().any(|r| schema::path_under(p, r)) {
                    continue;
                }
                c.execute("UPDATE documents SET in_library = 0, pinned = 0 WHERE id = ?1", params![id])?;
                demoted += 1;
            }
            Ok(demoted)
        })
    }

    pub fn list_roots(&self) -> Result<Vec<String>> {
        self.with_read(|c| {
            let mut st = c.prepare("SELECT path FROM roots ORDER BY id")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn settings(&self) -> Result<Settings> {
        let raw: Option<String> = self.with_read(|c| {
            c.query_row("SELECT value FROM settings WHERE key = 'settings'", [], |r| r.get(0))
                .optional()
        })?;
        // 坏 JSON 回退默认（用户带着旧配置升级不许崩）
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    pub fn set_settings(&self, s: &Settings) -> Result<()> {
        let json = serde_json::to_string(s).map_err(|e| CoreError::Db(e.to_string()))?;
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO settings(key, value) VALUES('settings', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = ?1",
                params![json],
            )?;
            Ok(())
        })
    }
}

/// 单篇写入的唯一 SQL 落点（普通保存与扫描批量共用）：
/// 事务内可被 `apply_scan` 复用；所有语句走 `prepare_cached`，批量扫描不再逐篇重新编译。
fn upsert_prepared(c: &Connection, d: &DocUpsert) -> rusqlite::Result<()> {
    let path_str = d.path.to_string_lossy();
    let existing: Option<(i64, String)> = c
        .prepare_cached("SELECT id, slug FROM documents WHERE path = ?1 COLLATE NOCASE")?
        .query_row(params![path_str.as_ref()], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let id = match existing {
        Some((id, _)) => id,
        None => {
            // PERF-03：slug 冲突只需知道同族 slug（base、base-2、base-3…），不拉全表。
            let base = markdown::slugify(&d.file_name);
            let like = format!("{}-%", escape_like(&base));
            let taken: HashSet<String> = {
                let mut st = c.prepare_cached(
                    "SELECT slug FROM documents WHERE slug = ?1 OR slug LIKE ?2 ESCAPE '\\'",
                )?;
                let rows = st.query_map(params![base, like], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let slug = markdown::unique_slug(&base, &taken);
            c.prepare_cached(
                "INSERT INTO documents(path, slug, title, dir, file_name, size, mtime,
                    word_count, head_count, sec_count, in_library, builtin)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            )?
            .execute(params![
                path_str.as_ref(), slug, d.title, d.dir, d.file_name, d.size as i64, d.mtime,
                d.word_count, d.head_count, d.sec_count, d.in_library as i64, d.builtin as i64
            ])?;
            c.last_insert_rowid()
        }
    };
    // builtin 只增不减：欢迎页后来被当作普通文件打开，也不许丢它的内置身份
    c.prepare_cached(
        "UPDATE documents SET title=?1, dir=?2, file_name=?3, size=?4, mtime=?5,
            word_count=?6, head_count=?7, sec_count=?8, in_library=?9,
            builtin = MAX(builtin, ?10) WHERE id=?11",
    )?
    .execute(params![
        d.title, d.dir, d.file_name, d.size as i64, d.mtime,
        d.word_count, d.head_count, d.sec_count, d.in_library as i64,
        d.builtin as i64, id
    ])?;
    let id_str = id.to_string();
    c.prepare_cached("DELETE FROM docs_fts WHERE doc = ?1")?.execute(params![id_str])?;
    c.prepare_cached("INSERT INTO docs_fts(title, body, doc) VALUES(?1, ?2, ?3)")?
        .execute(params![d.title, d.src, id_str])?;
    c.prepare_cached("INSERT OR REPLACE INTO doc_chars(doc_id, bitmap) VALUES(?1, ?2)")?
        .execute(params![id, d.bitmap.as_slice()])?;
    Ok(())
}

/// 回收一条登记的全部痕迹：历史 / 索引 / 进度 / 登记行。磁盘文件不动。
/// 本项目未开 `PRAGMA foreign_keys`，声明式的 ON DELETE CASCADE 不会触发，必须逐表删。
fn purge_conn(c: &Connection, id: i64) -> rusqlite::Result<()> {
    c.execute("DELETE FROM recents WHERE doc_id = ?1", params![id])?;
    c.execute("DELETE FROM docs_fts WHERE doc = ?1", params![id.to_string()])?;
    c.execute("DELETE FROM doc_chars WHERE doc_id = ?1", params![id])?;
    c.execute("DELETE FROM positions WHERE doc_id = ?1", params![id])?;
    c.execute("DELETE FROM documents WHERE id = ?1", params![id])?;
    Ok(())
}

fn row_to_meta(r: &rusqlite::Row) -> rusqlite::Result<DocMeta> {
    Ok(DocMeta {
        id: r.get("id")?,
        path: r.get("path")?,
        slug: r.get("slug")?,
        title: r.get("title")?,
        dir: r.get("dir")?,
        file_name: r.get("file_name")?,
        size: r.get::<_, i64>("size")? as u64,
        mtime: r.get("mtime")?,
        word_count: r.get("word_count")?,
        head_count: r.get("head_count")?,
        sec_count: r.get("sec_count")?,
        in_library: r.get::<_, i64>("in_library")? != 0,
        pinned: r.get::<_, i64>("pinned")? != 0,
        builtin: r.get::<_, i64>("builtin")? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("folio-db-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Db::open(&dir.join("f.db")).unwrap(), dir)
    }

    fn doc_file(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn short_search_uses_char_bitmap_candidates() {
        let (db, dir) = tmp_db("short");
        let a = doc_file(&dir, "a.md", "# A\n\n大纲与文档");
        let b = doc_file(&dir, "b.md", "# B\n\n只有文字");
        let ma = db.upsert_document(&a, "# A\n\n大纲与文档", true).unwrap();
        let mb = db.upsert_document(&b, "# B\n\n只有文字", true).unwrap();
        assert_eq!(db.search_short_doc_ids("大纲", 64).unwrap().unwrap(), vec![ma.id]);
        assert_eq!(db.search_short_doc_ids("纲", 64).unwrap().unwrap(), vec![ma.id]);
        let both = db.search_short_doc_ids("文", 64).unwrap().unwrap();
        assert!(both.contains(&ma.id) && both.contains(&mb.id), "两篇都含「文」");
        assert_eq!(db.search_short_doc_ids("猫", 64).unwrap().unwrap(), Vec::<i64>::new());
        assert!(db.search_short_doc_ids("三字符", 64).unwrap().is_none(), "≥3 字交给 FTS");

        let c = doc_file(&dir, "c.md", "# C\n\nHELLO");
        let mc = db.upsert_document(&c, "# C\n\nHELLO", true).unwrap();
        assert!(db.search_short_doc_ids("he", 64).unwrap().unwrap().contains(&mc.id), "ASCII 大小写不敏感");
    }

    #[test]
    fn upsert_list_and_unique_slug() {
        let (db, dir) = tmp_db("cr");
        let a = doc_file(&dir, "note.md", "# A\n\nbody");
        let b = doc_file(&dir, "note (2).md", "# B\n\nbody");
        let ma = db.upsert_document(&a, "# A\n\nbody", true).unwrap();
        let mb = db.upsert_document(&b, "# B\n\nbody", true).unwrap();
        assert_eq!(ma.slug, "note");
        assert_eq!(mb.slug, "note-2");
        assert_eq!(db.list_docs().unwrap().len(), 2);
        let ma2 = db.upsert_document(&a, "# A\n\nbody v2", true).unwrap();
        assert_eq!(ma2.id, ma.id);
        assert_eq!(db.list_docs().unwrap().len(), 2);
        assert_eq!(db.doc_by_slug("note").unwrap().path, a.to_string_lossy());
    }

    #[test]
    fn fts_trigram_and_like_paths() {
        let (db, dir) = tmp_db("fts");
        let p = doc_file(&dir, "t.md", "# 大纲与滚动\n\n大纲联动很好用\n");
        db.upsert_document(&p, "# 大纲与滚动\n\n大纲联动很好用\n", true).unwrap();
        assert_eq!(db.search_doc_ids(Some("\"大纲联动\""), None, 50).unwrap().len(), 1);
        assert_eq!(db.search_doc_ids(None, Some("%大纲%"), 50).unwrap().len(), 1);
        assert!(db.search_doc_ids(None, Some("%不存在的词%"), 50).unwrap().is_empty());
    }

    #[test]
    fn positions_and_settings_roundtrip() {
        let (db, dir) = tmp_db("pos");
        let p = doc_file(&dir, "x.md", "# X\n\ny");
        let m = db.upsert_document(&p, "# X\n\ny", true).unwrap();
        db.save_position(
            m.id,
            &Position { ratio: 0.5, sec: Some(1), sec_text: Some("X".into()), sec_off: 12.0, sec_line_off: 7.25, updated_at: 999 },
        )
        .unwrap();
        let ps = db.positions().unwrap();
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].1.sec_text.as_deref(), Some("X"));
        // v6：章节行偏移随 save/load 原样往返（恢复主坐标，方案 §4.3）
        assert_eq!(ps[0].1.sec_line_off, 7.25);
        let mut s = Settings::default();
        s.theme = "light".into();
        db.set_settings(&s).unwrap();
        assert_eq!(db.settings().unwrap().theme, "light");
    }

    #[test]
    fn migrate_v1_to_v2() {
        // 用 v1 DDL 建旧库、user_version=1，再经 Db::open 验证 v2 迁移幂等可用
        let dir = std::env::temp_dir().join("folio-db-test-mig");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dbf = dir.join("f.db");
        {
            let c = rusqlite::Connection::open(&dbf).unwrap();
            c.execute_batch(
                "CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE,
                 slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, dir TEXT NOT NULL, file_name TEXT NOT NULL,
                 size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
                 word_count INTEGER NOT NULL DEFAULT 0, head_count INTEGER NOT NULL DEFAULT 0,
                 sec_count INTEGER NOT NULL DEFAULT 0, in_library INTEGER NOT NULL DEFAULT 1);
                 CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, doc UNINDEXED, tokenize='trigram');
                 CREATE TABLE positions(doc_id INTEGER PRIMARY KEY, ratio REAL NOT NULL DEFAULT 0, sec INTEGER,
                 sec_text TEXT, sec_off REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
            let p = dir.join("old.md");
            std::fs::write(&p, "# old doc\n\ncontent").unwrap();
            c.execute(
                "INSERT INTO documents(path,slug,title,dir,file_name) VALUES(?1,'old','old doc','',  'old.md')",
                params![p.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        let db = Db::open(&dbf).unwrap();
        let docs = db.list_docs().unwrap();
        assert_eq!(docs.len(), 1);
        // v3 已连带跑完：该文档不在任何库根下 → 降级出库、pinned 归零
        assert!(!docs[0].pinned && !docs[0].in_library);
        // 置顶只对库成员生效（v3 规则）：先入库，再置顶
        db.set_in_library(docs[0].id, true).unwrap();
        db.set_pinned(docs[0].id, true).unwrap();
        assert!(db.list_docs().unwrap()[0].pinned);
        db.add_root("D:/r1").unwrap();
        db.add_root("D:/r1").unwrap(); // 幂等
        db.add_root("D:/r2").unwrap();
        assert_eq!(db.list_roots().unwrap().len(), 2);
        db.remove_root("D:/r1").unwrap();
        assert_eq!(db.list_roots().unwrap(), vec!["D:/r2".to_string()]);
    }

    #[test]
    fn library_membership_follows_roots_only() {
        // v3 判定口径：库成员 = 位于已登记库根之下。单开文件、库根之外的文件都不入库。
        let (db, dir) = tmp_db("member");
        let root = dir.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(dir.join("lib2")).unwrap();
        db.add_root(&root.to_string_lossy()).unwrap();
        let inside = doc_file(&root, "in.md", "# In\n");
        let outside = doc_file(&dir, "out.md", "# Out\n");
        let sibling = doc_file(&dir.join("lib2"), "s.md", "# S\n");
        assert!(db.library_membership(&inside).unwrap());
        assert!(!db.library_membership(&outside).unwrap());
        // 前缀必须踩在分隔符边界上：lib2 不许被 lib 命中
        assert!(!db.library_membership(&sibling).unwrap());
        // 打开单个文件不入库，只记历史
        let m = db.upsert_document(&outside, "# Out\n", false).unwrap();
        db.record_recent(m.id, 1000).unwrap();
        db.record_recent(m.id, 3000).unwrap(); // 重复打开=刷新时间，不翻倍
        let r = db.list_recents().unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].meta.id, m.id);
        assert_eq!(r[0].opened_at, 3000);
        assert_eq!(db.list_docs().unwrap().len(), 1);
        // 置顶对非库成员静默不生效；取消总允许
        db.set_pinned(m.id, true).unwrap();
        assert!(!db.list_docs().unwrap()[0].pinned);
    }

    #[test]
    fn clear_recents_prunes_orphans_keeps_library_and_builtin() {
        let (db, dir) = tmp_db("clear");
        let root = dir.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        db.add_root(&root.to_string_lossy()).unwrap();
        let a = doc_file(&root, "a.md", "# A\n");
        let b = doc_file(&dir, "b.md", "# B\n");
        let w = doc_file(&dir, "welcome.md", "# 欢迎\n");
        let ma = db.upsert_document(&a, "# A\n", true).unwrap();
        let mb = db.upsert_document(&b, "# B\n", false).unwrap();
        let mw = db.upsert_builtin_document(&w, "# 欢迎\n").unwrap();
        for (id, t) in [(ma.id, 1000), (mb.id, 2000), (mw.id, 3000)] {
            db.record_recent(id, t).unwrap();
            db.save_position(
                id,
                &Position { ratio: 0.4, sec: Some(1), sec_text: None, sec_off: 0.0, sec_line_off: -1.0, updated_at: t },
            )
            .unwrap();
        }
        db.set_pinned(ma.id, true).unwrap();
        let rep = db.clear_recents().unwrap();
        assert_eq!(rep.cleared, 3);
        assert_eq!(rep.pruned, 1, "只回收失去归属的登记（单开的 b）");
        let left: Vec<i64> = db.list_docs().unwrap().iter().map(|d| d.id).collect();
        assert_eq!(left.len(), 2);
        assert!(left.contains(&ma.id) && left.contains(&mw.id));
        assert!(db.list_recents().unwrap().is_empty());
        let pos: Vec<i64> = db.positions().unwrap().iter().map(|(id, _)| *id).collect();
        assert!(pos.contains(&ma.id), "库成员进度不受影响");
        assert!(pos.contains(&mw.id), "内置文档进度不受影响");
        assert!(!pos.contains(&mb.id));
        assert!(db.list_docs().unwrap().iter().find(|d| d.id == ma.id).unwrap().pinned);
        assert!(a.exists() && b.exists() && w.exists(), "只删登记，不动磁盘");
    }

    #[test]
    fn remove_recent_prunes_only_when_doc_has_no_other_home() {
        let (db, dir) = tmp_db("rmrecent");
        let root = dir.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        db.add_root(&root.to_string_lossy()).unwrap();
        let a = doc_file(&root, "a.md", "# A\n");
        let b = doc_file(&dir, "b.md", "# B\n");
        let ma = db.upsert_document(&a, "# A\n", true).unwrap();
        let mb = db.upsert_document(&b, "# B\n", false).unwrap();
        db.record_recent(ma.id, 1).unwrap();
        db.record_recent(mb.id, 2).unwrap();
        assert!(!db.remove_recent(ma.id).unwrap(), "库成员：只清历史，登记留着");
        assert_eq!(db.list_docs().unwrap().len(), 2);
        assert!(db.remove_recent(mb.id).unwrap(), "非库成员：登记连带回收");
        assert_eq!(db.list_docs().unwrap().len(), 1);
        assert!(db.positions().unwrap().iter().all(|(id, _)| *id != mb.id));
        assert!(a.exists() && b.exists());
    }

    #[test]
    fn set_in_library_demotes_and_clears_pinned() {
        let (db, dir) = tmp_db("demote");
        let a = doc_file(&dir, "a.md", "# A\n");
        let ma = db.upsert_document(&a, "# A\n", true).unwrap();
        db.set_pinned(ma.id, true).unwrap();
        db.set_in_library(ma.id, false).unwrap();
        let d = db.list_docs().unwrap().remove(0);
        assert!(!d.in_library && !d.pinned, "出库=取消置顶（置顶是库内分组语义）");
        db.set_in_library(ma.id, true).unwrap();
        assert!(db.list_docs().unwrap()[0].in_library, "重新入库不复活置顶");
    }

    #[test]
    fn migrate_v2_to_v4_net_effect_and_seed_history() {
        // 手工造 v2 旧库（旧规则「打开即入库」= in_library 全 1，唯一 in_library=0 的是内置 welcome）
        let dir = std::env::temp_dir().join("folio-db-test-mig3");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dbf = dir.join("f.db");
        let root = dir.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("in.md");
        let outside = dir.join("out.md");
        let welcome = dir.join("welcome.md");
        for p in [&inside, &outside, &welcome] {
            std::fs::write(p, "# t\n").unwrap();
        }
        {
            let c = rusqlite::Connection::open(&dbf).unwrap();
            c.execute_batch(
                "CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE,
                 slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, dir TEXT NOT NULL, file_name TEXT NOT NULL,
                 size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
                 word_count INTEGER NOT NULL DEFAULT 0, head_count INTEGER NOT NULL DEFAULT 0,
                 sec_count INTEGER NOT NULL DEFAULT 0, in_library INTEGER NOT NULL DEFAULT 1,
                 pinned INTEGER NOT NULL DEFAULT 0);
                 CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, doc UNINDEXED, tokenize='trigram');
                 CREATE TABLE positions(doc_id INTEGER PRIMARY KEY, ratio REAL NOT NULL DEFAULT 0, sec INTEGER,
                 sec_text TEXT, sec_off REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE roots(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE);
                 PRAGMA user_version = 2;",
            )
            .unwrap();
            c.execute(
                "INSERT INTO documents(path,slug,title,dir,file_name,mtime,in_library,pinned)
                 VALUES(?1,'in','in','', 'in.md',10,1,1),
                       (?2,'out','out','', 'out.md',20,1,1),
                       (?3,'welcome','welcome','', 'welcome.md',5,0,0)",
                rusqlite::params![
                    inside.to_string_lossy().to_string(),
                    outside.to_string_lossy().to_string(),
                    welcome.to_string_lossy().to_string()
                ],
            )
            .unwrap();
            c.execute("INSERT INTO roots(path) VALUES(?1)", rusqlite::params![root.to_string_lossy().to_string()]).unwrap();
            // 只有 out.md 有阅读进度：v3 应据此回填一条历史
            c.execute(
                "INSERT INTO positions(doc_id,ratio,updated_at) VALUES(2,0.5,777)",
                [],
            )
            .unwrap();
        }
        let db = Db::open(&dbf).unwrap();
        let by: std::collections::HashMap<String, DocMeta> = db
            .list_docs()
            .unwrap()
            .into_iter()
            .map(|d| (d.file_name.clone(), d))
            .collect();
        // v3 的"按 roots 重算成员"随后被 v4 的单库决议覆盖：旧根一并清空、成员全部降级、置顶归零。
        // 这里因此只校验 v4 的净结果 + v3 留下的两项成果（内置识别、按进度回填历史）。
        assert_eq!(db.list_roots().unwrap().len(), 0, "v4：旧库根清空，不猜该留哪个");
        assert!(by.values().all(|d| !d.in_library), "库成员全部降级为仅最近打开");
        assert!(by.values().all(|d| !d.pinned), "置顶全部归零");
        assert!(by["welcome.md"].builtin, "旧规则里唯一 in_library=0 的行识别为内置");
        let r = db.list_recents().unwrap();
        assert_eq!(r.len(), 1, "只给有进度记录的条目回填历史");
        assert_eq!(r[0].meta.file_name, "out.md");
        assert_eq!(r[0].opened_at, 777, "时间取进度 updated_at");
        // 幂等：重开一次不许有变化
        drop(db);
        let db = Db::open(&dbf).unwrap();
        assert_eq!(db.list_recents().unwrap().len(), 1);
        assert_eq!(db.list_docs().unwrap().len(), 3);
        assert!(db.list_docs().unwrap().iter().find(|d| d.file_name == "welcome.md").unwrap().builtin);
    }

    /// 真实用户库副本的迁移冒烟（默认 ignore，升级发布前手工跑一次）：
    ///   FOLIO_DB_COPY="%APPDATA%/app.folio.desktop/folio.db" \
    ///     cargo test -p folio-db -- --ignored --nocapture migrate_real_user_copy
    /// 需要该目录下有 folio.db-wal/-shm 一并复制；本测试只动临时副本，绝不碰原库。
    #[test]
    #[ignore]
    fn migrate_real_user_copy() {
        let src = std::env::var("FOLIO_DB_COPY").expect("设 FOLIO_DB_COPY=<真实库路径>");
        let src = std::path::Path::new(&src);
        let dir = std::env::temp_dir().join("folio-db-real-check");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("folio.db");
        std::fs::copy(src, &dst).unwrap();
        for suffix in ["-wal", "-shm"] {
            let p = src.with_file_name(
                format!("{}{}", src.file_name().unwrap().to_string_lossy(), suffix),
            );
            if p.exists() {
                std::fs::copy(&p, dst.with_file_name(format!("folio.db{}", suffix))).ok();
            }
        }

        let stat = |label: &str, db: &Db| {
            let docs = db.list_docs().unwrap_or_default();
            println!(
                "[{label}] 登记 {} · 库成员 {} · 置顶 {} · 内置 {} · 库根 {} · 历史 {}",
                docs.len(),
                docs.iter().filter(|d| d.in_library).count(),
                docs.iter().filter(|d| d.pinned).count(),
                docs.iter().filter(|d| d.builtin).count(),
                db.list_roots().unwrap_or_default().len(),
                db.list_recents().unwrap_or_default().len(),
            );
            (docs, db.list_roots().unwrap_or_default())
        };

        // 迁移前：只读打开原副本（用 V2 语义的列查询，不触发 setup）
        {
            let c = rusqlite::Connection::open(&dst).unwrap();
            let n: i64 = c.query_row("SELECT count(*) FROM documents", [], |r| r.get(0)).unwrap();
            let lib: i64 = c
                .query_row("SELECT count(*) FROM documents WHERE in_library = 1", [], |r| r.get(0))
                .unwrap();
            let roots: i64 = c.query_row("SELECT count(*) FROM roots", [], |r| r.get(0)).unwrap();
            println!("[迁移前] 登记 {n} · in_library=1 {lib} · roots {roots}");
        }
        let db = Db::open(&dst).unwrap();
        let (docs, roots) = stat("迁移后", &db);
        // 关键不变量：不许有「既不在库、又没有任何打开历史」的条目凭空隐身
        let recents = db.list_recents().unwrap();
        let hidden: Vec<&DocMeta> = docs
            .iter()
            .filter(|d| !d.in_library && !d.builtin && !recents.iter().any(|r| r.meta.id == d.id))
            .collect();
        println!("[隐身检查] 不在库、非内置、也不在历史里的条目 = {}", hidden.len());
        for d in hidden.iter().take(10) {
            println!("   隐身: {}", d.path);
        }
        println!("[库根] {roots:?}");
        for d in docs.iter().filter(|d| d.in_library).take(5) {
            println!("   在库: {}", d.path);
        }
        assert!(db.list_docs().unwrap().len() >= 1, "副本里应有数据可比");
    }

    /// 真正的 v3 库：documents 带 builtin、且有 recents 表（v3 迁移的产物）
    fn hand_v3_db(dir: &Path) -> std::path::PathBuf {
        let dbf = dir.join("f.db");
        let c = rusqlite::Connection::open(&dbf).unwrap();
        c.execute_batch(
            "CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE,
             slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, dir TEXT NOT NULL, file_name TEXT NOT NULL,
             size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
             word_count INTEGER NOT NULL DEFAULT 0, head_count INTEGER NOT NULL DEFAULT 0,
             sec_count INTEGER NOT NULL DEFAULT 0, in_library INTEGER NOT NULL DEFAULT 1,
             pinned INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE positions(doc_id INTEGER PRIMARY KEY, ratio REAL NOT NULL DEFAULT 0, sec INTEGER,
             sec_text TEXT, sec_off REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE roots(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE recents(doc_id INTEGER PRIMARY KEY, opened_at INTEGER NOT NULL DEFAULT 0);
             PRAGMA user_version = 3;",
        )
        .unwrap();
        drop(c);
        dbf
    }

    #[test]
    fn replace_root_enforces_single_library() {
        let (db, dir) = tmp_db("replace");
        let (a, b) = (dir.join("libA"), dir.join("libB"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let fa = doc_file(&a, "x.md", "# X
");
        let fb = doc_file(&b, "y.md", "# Y
");
        let ma = db.upsert_document(&fa, "# X
", true).unwrap();
        let mb = db.upsert_document(&fb, "# Y
", true).unwrap();
        db.add_root(&a.to_string_lossy()).unwrap();
        db.add_root(&b.to_string_lossy()).unwrap();   // v4 之前的遗留局面：两个根并存

        // 切到 A：B 的成员降级 + 取消置顶；A 的成员与它的置顶都不受影响
        let (prev, demoted) = db.replace_root(&a.to_string_lossy()).unwrap();
        assert_eq!(prev.as_deref(), Some(b.to_str().unwrap()));
        assert_eq!(demoted, 1);
        assert_eq!(db.list_roots().unwrap(), vec![a.to_string_lossy().to_string()], "roots 只剩一行");
        db.set_pinned(ma.id, true).unwrap();   // 留在库里的这条置顶
        let docs = db.list_docs().unwrap();
        let da = docs.iter().find(|d| d.id == ma.id).unwrap();
        let db2 = docs.iter().find(|d| d.id == mb.id).unwrap();
        assert!(da.in_library && da.pinned, "新根成员与它的置顶都不受影响");
        assert!(!db2.in_library && !db2.pinned, "被关旧根的成员：降级 + 取消置顶");

        // 反向切换到 B：对称地，A 的成员出库、置顶归零。
        // 注意 replace_root 只"关旧"，不负责"提新"——新根成员的入库由紧随其后的扫描补
        // （commands::scan 的 unchanged 分支）。真实切换路径见 src-tauri/tests/m2.rs。
        let (prev2, d2) = db.replace_root(&b.to_string_lossy()).unwrap();
        assert_eq!(prev2.as_deref(), Some(a.to_str().unwrap()));
        assert_eq!(d2, 1);
        let after = db.list_docs().unwrap();
        let ma_after = after.iter().find(|d| d.id == ma.id).unwrap();
        let mb_after = after.iter().find(|d| d.id == mb.id).unwrap();
        assert!(!ma_after.in_library && !ma_after.pinned, "出库即取消置顶");
        assert!(!mb_after.in_library, "只关不提：等扫描补登记");
        assert_eq!(after.len(), 2, "登记行不因切换而消失");
        assert!(fa.exists() && fb.exists(), "只动归属，不碰磁盘");
    }

    #[test]
    fn replace_root_with_nested_roots_spares_overlap() {
        // 旧根 D:/docs、新根 D:/docs/sub：交叠处的文档不许被"关旧根"误伤
        let (db, dir) = tmp_db("nested");
        let outer = dir.join("docs");
        let inner = outer.join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        let f = doc_file(&inner, "a.md", "# A
");
        let m = db.upsert_document(&f, "# A
", true).unwrap();
        db.add_root(&outer.to_string_lossy()).unwrap();
        let (prev, demoted) = db.replace_root(&inner.to_string_lossy()).unwrap();
        assert_eq!(prev.as_deref(), Some(outer.to_str().unwrap()));
        assert_eq!(demoted, 0, "仍在新根之下：不降级");
        assert!(db.list_docs().unwrap().iter().find(|d| d.id == m.id).unwrap().in_library);
    }

    #[test]
    fn migrate_v3_to_v4_clears_both_legacy_roots() {
        // 用户决议：切到单库策略时不猜该留哪个库，两个旧根一起清掉。
        // 净效果：roots 空、非内置成员全降级、置顶归零；登记行、进度、历史、内置标记一项不少。
        let dir = std::env::temp_dir().join("folio-db-test-v4");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dbf = hand_v3_db(&dir);
        let (r1, r2) = (dir.join("docs1"), dir.join("docs2"));
        std::fs::create_dir_all(&r1).unwrap();
        std::fs::create_dir_all(&r2).unwrap();
        let f1 = r1.join("a.md");
        let f2 = r2.join("b.md");
        std::fs::write(&f1, "# A
").unwrap();
        std::fs::write(&f2, "# B
").unwrap();
        {
            let c = rusqlite::Connection::open(&dbf).unwrap();
            // welcome 按 v3 的真实产物写成 builtin=1（v3 的"由 in_library=0 反推"在这条路径上已跑过）
            c.execute(
                "INSERT INTO documents(path,slug,title,dir,file_name,mtime,in_library,pinned,builtin)
                 VALUES(?1,'a','a','','a.md',10,1,1,0),(?2,'b','b','','b.md',20,1,0,0),(?3,'welcome','w','','welcome.md',5,0,0,1)",
                rusqlite::params![f1.to_string_lossy().to_string(), f2.to_string_lossy().to_string(),
                                  dir.join("welcome.md").to_string_lossy().to_string()],
            ).unwrap();
            c.execute(
                "INSERT INTO recents(doc_id,opened_at) VALUES(1,888)",
                [],
            ).unwrap();
            c.execute("INSERT INTO roots(path) VALUES(?1),(?2)",
                rusqlite::params![r1.to_string_lossy().to_string(), r2.to_string_lossy().to_string()]).unwrap();
            c.execute("INSERT INTO positions(doc_id,ratio,updated_at) VALUES(1,0.5,888)", []).unwrap();
        }
        let db = Db::open(&dbf).unwrap();
        assert_eq!(db.list_roots().unwrap().len(), 0, "两个旧根一起清空");
        let docs = db.list_docs().unwrap();
        assert_eq!(docs.len(), 3, "登记行一条不少");
        assert!(docs.iter().all(|d| !d.in_library), "库成员全部降级");
        assert!(docs.iter().all(|d| !d.pinned), "置顶归零");
        assert!(docs.iter().any(|d| d.builtin), "内置标记由 v3 补齐且不受 v4 影响");
        let r = db.list_recents().unwrap();
        assert_eq!(r.len(), 1, "打开历史保留");
        assert_eq!(r[0].opened_at, 888);
        assert_eq!(db.positions().unwrap().len(), 1, "阅读进度保留");
        assert!(f1.exists() && f2.exists(), "磁盘文件不动");
        drop(db);
        let db = Db::open(&dbf).unwrap();   // 幂等重放
        assert_eq!(db.list_docs().unwrap().len(), 3);
        assert_eq!(db.list_recents().unwrap().len(), 1);
    }

    #[test]
    fn remove_doc_clears_fts_and_keeps_file() {
        let (db, dir) = tmp_db("rmdoc");
        let p = doc_file(&dir, "gone.md", "# 待移除\n\n唯一内容ABC");
        db.upsert_document(&p, "# 待移除\n\n唯一内容ABC", true).unwrap();
        assert_eq!(db.search_doc_ids(Some("\"唯一内容ABC\""), None, 10).unwrap().len(), 1);
        let id = db.doc_by_path(&p.to_string_lossy()).unwrap().id;
        db.remove_doc(id).unwrap();
        assert!(db.search_doc_ids(Some("\"唯一内容ABC\""), None, 10).unwrap().is_empty());
        assert!(p.exists()); // 只删登记，不动磁盘
    }

    #[test]
    fn sync_removes_deleted_but_spares_outside_docs() {
        let (db, dir) = tmp_db("sync");
        let lib_dir = dir.join("lib");
        std::fs::create_dir_all(&lib_dir).unwrap();
        let a = doc_file(&lib_dir, "a.md", "# a");
        let b = doc_file(&lib_dir, "b.md", "# b");
        let outside = doc_file(dir.parent().unwrap_or(dir.as_path()), "folio-outside-test.md", "# o");
        db.upsert_document(&a, "# a", true).unwrap();
        db.upsert_document(&b, "# b", true).unwrap();
        db.upsert_document(&outside, "# o", false).unwrap(); // 单开：不在库根，也不应被 sync 触及
        std::fs::remove_file(&b).unwrap();
        let scanned: HashSet<String> = [a.to_string_lossy().to_lowercase()].into_iter().collect();
        let removed = db.sync_library(&lib_dir, &scanned).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(db.list_docs().unwrap().len(), 2); // a + outside
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn list_recents_dedupes_same_file_to_last_open() {
        // v1.2 §5.3：同一物理文件的多形态登记行（斜杠/反斜杠）在历史里只留最后一次打开
        let (db, _dir) = tmp_db("recdedup");
        let back = std::path::Path::new("D:\\dup\\a.md");
        let slash = std::path::Path::new("D:/dup/a.md");
        db.upsert_document(back, "# A", false).unwrap();
        db.upsert_document(slash, "# A", false).unwrap();
        let id_back = db.doc_by_path("D:\\dup\\a.md").unwrap().id;
        let id_slash = db.doc_by_path("D:/dup/a.md").unwrap().id;
        db.record_recent(id_back, 500).unwrap();
        db.record_recent(id_slash, 900).unwrap(); // 斜杠形态后开
        let rc = db.list_recents().unwrap();
        let hits: Vec<_> = rc.iter().filter(|r| r.meta.path.to_lowercase().replace('\\', "/") == "d:/dup/a.md").collect();
        assert_eq!(hits.len(), 1, "同文件必须只剩一条历史条目");
        assert_eq!(hits[0].opened_at, 900, "保留的是最后一次打开");
        assert_eq!(hits[0].meta.id, id_slash);
        assert!(db.remove_doc(id_back).is_ok() && db.remove_doc(id_slash).is_ok());
    }

    #[test]
    fn v5_migration_repairs_drive_relative_and_demotes_orphans() {
        // 用 Z: 前缀做纯字符串样本（本机不存在该盘，metadata 一律失败，行为确定）
        let dir = std::env::temp_dir().join("folio-db-test-v5fix");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dbf = dir.join("f.db");
        {
            let db = Db::open(&dbf).unwrap(); // 先建好 v5 全表结构
            let lib = dir.join("lib");
            std::fs::create_dir_all(&lib).unwrap();
            db.replace_root(&lib.to_string_lossy()).unwrap(); // 真根在册
            let real = doc_file(&lib, "r.md", "# R");
            db.upsert_document(&real, "# R", true).unwrap(); // 正常成员：迁移后必须原样保留
            // ① 毒行+孪生：历史与进度应并入孪生、毒行回收
            let twin = std::path::Path::new("Z:\\lib\\a.md");
            let poison = std::path::Path::new("Z:lib\\a.md");
            db.upsert_document(twin, "# A", false).unwrap();
            let tid = db.doc_by_path(&twin.to_string_lossy()).unwrap().id;
            db.record_recent(tid, 100).unwrap();
            db.upsert_document(poison, "# A", true).unwrap();
            let pid = db.doc_by_path(&poison.to_string_lossy()).unwrap().id;
            db.record_recent(pid, 500).unwrap();
            db.save_position(pid, &Position { ratio: 0.5, sec: None, sec_text: None, sec_off: 0.0, sec_line_off: 42.5, updated_at: 1 }).unwrap();
            // ② 无毒孪生：原位修路径
            let lone = std::path::Path::new("Z:lib\\c.md");
            db.upsert_document(lone, "# C", true).unwrap();
            // ③ 违例非毒行（不在任何根下）：必须降级
            let orphan = std::path::Path::new("Z:\\other\\d.md");
            db.upsert_document(orphan, "# D", true).unwrap();
            drop(db);
            let c = rusqlite::Connection::open(&dbf).unwrap(); // 把数据退回「v5 迁移前」的状态
            c.pragma_update(None, "user_version", 4).unwrap();
        }
        let db = Db::open(&dbf).unwrap(); // 触发 v5
        assert!(db.doc_by_path("Z:lib\\a.md").is_err(), "毒孪生行应被回收");
        let twin_after = db.doc_by_path("Z:\\lib\\a.md").unwrap();
        assert_eq!(
            db.list_recents().unwrap().iter().find(|r| r.meta.id == twin_after.id).unwrap().opened_at,
            500, "历史取 MAX"
        );
        assert_eq!(db.positions().unwrap().iter().filter(|(id, _)| *id == twin_after.id).count(), 1, "进度并入孪生");
        let lone_after = db.doc_by_path("Z:\\lib\\c.md").unwrap();
        assert!(!lone_after.in_library, "毒不在根下 → 降级");
        assert!(!db.doc_by_path("Z:\\other\\d.md").unwrap().in_library, "违例非毒行同样降级");
        assert!(db.doc_by_path(&real_path(&dir)).map(|m| m.in_library).unwrap_or(false), "正常成员不受牵连");
        drop(db);
        let db = Db::open(&dbf).unwrap(); // 幂等重放
        assert!(db.doc_by_path("Z:lib\\a.md").is_err());
        assert_eq!(db.list_docs().unwrap().len(), 4); // r + twin + lone + orphan
    }

    fn real_path(dir: &std::path::Path) -> String {
        dir.join("lib").join("r.md").to_string_lossy().into_owned()
    }

    #[test]
    fn sync_library_respects_separator_boundary() {
        // CON-05：库根 …\docs 不得把同级 …\docs2 的条目当"库内未扫到"而回收
        //（旧实现手写 starts_with(prefix) 会误删；统一走 schema::path_under 后必须为 0）
        let (db, dir) = tmp_db("syncboundary");
        let docs = dir.join("docs");
        let docs2 = dir.join("docs2");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::create_dir_all(&docs2).unwrap();
        let in2 = doc_file(&docs2, "x.md", "# x");
        db.upsert_document(&in2, "# x", true).unwrap();
        let removed = db.sync_library(&docs, &HashSet::new()).unwrap();
        assert_eq!(removed, 0, "docs2 的条目不属于 docs 库");
        assert!(db.doc_by_path(&in2.to_string_lossy()).is_ok());
    }
}
