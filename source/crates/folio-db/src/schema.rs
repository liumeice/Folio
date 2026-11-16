use rusqlite::{Connection, OptionalExtension};

/// 路径归一（比对用）：小写 + 反斜杠转斜杠。Windows 是主战场，大小写不敏感由 SQLite
/// COLLATE NOCASE 与这里的归一共同保证。
pub(crate) fn norm_path(p: &str) -> String {
    p.to_lowercase().replace('\\', "/")
}

/// 目录归一：在 norm_path 基础上去掉结尾分隔符（与 sync_library 的库根口径一致）
pub(crate) fn norm_dir(p: &str) -> String {
    let mut s = norm_path(p);
    while s.ends_with('/') {
        s.pop();
    }
    s
}

/// 文件是否位于某目录之下。要求分隔符边界，避免 `D:/docs2/a.md` 命中根 `D:/docs`。
pub(crate) fn path_under(file: &str, dir: &str) -> bool {
    let f = norm_path(file);
    let d = norm_dir(dir);
    if d.is_empty() {
        return false;
    }
    f.starts_with(&d) && f.as_bytes().get(d.len()) == Some(&b'/')
}

/// user_version 版本化迁移。v1：documents + docs_fts(trigram) + positions + settings
pub fn setup(c: &Connection) -> rusqlite::Result<()> {
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    // P1-6：WAL 自动 checkpoint 降到 256 页（约 1MB），空闲时 -wal 不再无限膨胀
    c.pragma_update(None, "wal_autocheckpoint", 256)?;
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        c.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS documents(
                id         INTEGER PRIMARY KEY,
                path       TEXT NOT NULL UNIQUE COLLATE NOCASE,
                slug       TEXT NOT NULL UNIQUE,
                title      TEXT NOT NULL,
                dir        TEXT NOT NULL,
                file_name  TEXT NOT NULL,
                size       INTEGER NOT NULL DEFAULT 0,
                mtime      INTEGER NOT NULL DEFAULT 0,
                word_count INTEGER NOT NULL DEFAULT 0,
                head_count INTEGER NOT NULL DEFAULT 0,
                sec_count  INTEGER NOT NULL DEFAULT 0,
                in_library INTEGER NOT NULL DEFAULT 1,
                builtin    INTEGER NOT NULL DEFAULT 0
            );
            -- trigram：中文/混合任意 ≥3 字符子串可 MATCH（评审 v1 硬提醒的解法）
            CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                title, body, doc UNINDEXED, tokenize = 'trigram'
            );
            CREATE TABLE IF NOT EXISTS positions(
                doc_id     INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
                ratio      REAL NOT NULL DEFAULT 0,
                sec        INTEGER,
                sec_text   TEXT,
                sec_off    REAL NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 1;
            "#,
        )?;
    }
    if v < 2 {
        // schema v2（PRD §9 M2：置顶 / 多库根；迁移必须幂等可重放）
        let has_pinned: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('documents') WHERE name = 'pinned'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        if !has_pinned {
            c.execute("ALTER TABLE documents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", [])?;
        }
        c.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS roots(
                id   INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE COLLATE NOCASE
            );
            PRAGMA user_version = 2;
            "#,
        )?;
    }
    if v < 3 {
        // schema v3（2026-11-14 设计变更：文档库与「最近打开」彻底解耦）
        //   1) recents 表 = 打开历史（不限量）。只引用 documents.id，键空间仍唯一：
        //      同一文件不会有两行 → slug / 进度 / FTS 都不分叉。
        //      本项目未开 PRAGMA foreign_keys，级联不会触发，删除一律在各方法里手工补齐。
        //   2) in_library 重新判定：库成员 = 位于任一已登记库根之下（=「打开文件夹」的产物）。
        //      旧规则是「打开即入库」（open_doc 硬写 true），整表都是 1，这里按 roots 重算。
        //      降级出库的条目同时取消 pinned —— 置顶是「库」的分组语义，历史列表不分组的。
        //   3) 回填打开历史：有阅读进度记录者视为打开过，时间取进度 updated_at。
        //      只扫描未打开过的文件不进历史；打开过但从未滚动（无进度行）的历史无法追溯。
        //   可重放性：建表 IF NOT EXISTS、重算是全量覆写、回填是 INSERT OR IGNORE。
        let has_builtin: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('documents') WHERE name = 'builtin'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        if !has_builtin {
            c.execute("ALTER TABLE documents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0", [])?;
        }
        c.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS recents(
                doc_id    INTEGER PRIMARY KEY,
                opened_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_recents_time ON recents(opened_at DESC);
            "#,
        )?;

        // 老库的单一库根存在 settings.libraryRoot（roots 表 v2 才有，且早期扫描没写过）。
        // 注：紧随其后的 v4 会清空 roots——这段只在"停在 v3 不动"的历史语境里有意义，
        // v2→v4 一次跑完时它没有净效果，保留是为可读性与可回溯。
        // 必须先并进 roots，否则「按新规则重算」会把整批扫描登记的文档判成非库成员——
        // 实测口径：本机 139 篇全部位于该根之下，roots 表却是空的。
        let legacy_root: Option<String> = c
            .query_row("SELECT value FROM settings WHERE key = 'settings'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
            .and_then(|v| {
                v.get("libraryRoot")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string())
            })
            .filter(|s| !s.is_empty());
        if let Some(r) = legacy_root {
            c.execute("INSERT OR IGNORE INTO roots(path) VALUES(?1)", rusqlite::params![r])?;
        }
        // 旧规则下唯一写出 in_library=0 的行，就是内置欢迎文档（open_doc / scan / save 一律 true）
        // ——据此把 builtin 列补齐；内置文档既不入库，也不参与「清空最近打开」的回收。
        c.execute("UPDATE documents SET builtin = 1 WHERE in_library = 0", [])?;
        let roots: Vec<String> = {
            let mut st = c.prepare("SELECT path FROM roots")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let docs: Vec<(i64, String)> = {
            let mut st = c.prepare("SELECT id, path FROM documents WHERE builtin = 0")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, path) in &docs {
            let in_library = roots.iter().any(|r| path_under(path, r));
            c.execute(
                "UPDATE documents SET in_library = ?1,
                    pinned = CASE WHEN ?1 = 0 THEN 0 ELSE pinned END
                 WHERE id = ?2",
                rusqlite::params![in_library as i64, id],
            )?;
        }
        c.execute(
            "INSERT OR IGNORE INTO recents(doc_id, opened_at)
             SELECT d.id, COALESCE(p.updated_at, d.mtime)
             FROM documents d JOIN positions p ON p.doc_id = d.id",
            [],
        )?;
        c.pragma_update(None, "user_version", 3)?;
    }
    if v < 4 {
        // schema v4（2026-11-15 决议）：文档库同时只允许一个库根，且**不继承 v3 时代的归属**——
        // 一次性清空 roots 并把所有库成员降级为「仅最近打开」，由用户显式「打开文件夹…」重开一个库。
        // 为什么清而不是选一个留下：v3 的 in_library 是按新规则重算出来的历史结果（还出现过两个末段
        // 同名的 docs 根并存的局面），留哪个都算猜；清空后语义唯一、可一次点击复原。
        // 只动归属标记：磁盘文件、documents 登记行、FTS 索引、阅读进度、打开历史一律不碰。
        // 幂等：跑完 roots 为空、in_library 全 0，重放无副作用。
        c.execute("DELETE FROM roots", [])?;
        // 正常路径下 builtin 列由 v3 建好；这里仍做存在性防御，宁可少改也不让启动炸在迁移上
        let has_builtin: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('documents') WHERE name = 'builtin'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        let where_clause = if has_builtin { "WHERE builtin = 0" } else { "" };
        c.execute(&format!("UPDATE documents SET in_library = 0, pinned = 0 {where_clause}"), [])?;
        c.pragma_update(None, "user_version", 4)?;
    }
    if v < 5 {
        // schema v5（2026-11-16 实测缺陷修复）：修「驱动器相对毒路径」并强制库成员不变量。
        // 毒路径来源：曾选裸盘符根时，前端把 "D:\" 尾部分隔符裁成 "D:"，Rust
        // PathBuf::from("D:").join(name) == "D:name"（Windows 按该盘 CWD 解析，磁盘上真能读到，
        // 于是整盘内容被成批登记成 D:xxx 形态）。这类路径过不了 path_under 的根匹配 →
        // 换库时 replace_root 永远降不了它们的级 → 「打开文件夹」后目录树被 1000+ 条
        // 兜底条目淹没（面板不像目录结构）。
        // ① 修复：'X:name' 补分隔符成 'X:\name'；若正确形态已有孪生行 → 历史取 MAX、
        //    进度无人认领才搬家、毒行整体回收（slug/FTS 随 purge_conn 清，不动磁盘）。
        // ② 终局强制不变量 in_library ⇒ 位于已登记库根之下：残余违例降级为「仅最近打开」。
        // 幂等可重放：跑完后 ① 不再命中、② 是全量重查。
        let poison: Vec<(i64, String, String)> = {
            let mut st = c.prepare("SELECT id, path, dir FROM documents")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|(_, p, _)| is_drive_rel(p))
                .collect()
        };
        for (id, path, dir) in poison {
            let fixed_path = fix_drive_rel(&path);
            let mut fixed_dir = fix_drive_rel(&dir);
            if is_bare_drive(&dir) {
                fixed_dir.push('\\'); // 盘根直属文件的 dir 曾被存成裸 "D:"
            }
            let twin: Option<i64> = c
                .query_row(
                    "SELECT id FROM documents WHERE path = ?1 COLLATE NOCASE AND id != ?2",
                    rusqlite::params![fixed_path, id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            match twin {
                Some(t) => {
                    if let Some(at) = c
                        .query_row("SELECT opened_at FROM recents WHERE doc_id = ?1", rusqlite::params![id], |r| r.get::<_, i64>(0))
                        .optional()?
                    {
                        c.execute(
                            "INSERT INTO recents(doc_id, opened_at) VALUES(?1, ?2)
                             ON CONFLICT(doc_id) DO UPDATE SET opened_at = MAX(recents.opened_at, ?2)",
                            rusqlite::params![t, at],
                        )?;
                    }
                    let twin_pos: i64 = c
                        .query_row("SELECT count(*) FROM positions WHERE doc_id = ?1", rusqlite::params![t], |r| r.get(0))?;
                    if twin_pos == 0 {
                        c.execute("UPDATE positions SET doc_id = ?1 WHERE doc_id = ?2", rusqlite::params![t, id])?;
                    }
                    crate::purge_conn(c, id)?;
                }
                None => {
                    c.execute(
                        "UPDATE documents SET path = ?1, dir = ?2 WHERE id = ?3",
                        rusqlite::params![fixed_path, fixed_dir, id],
                    )?;
                }
            }
        }
        let roots: Vec<String> = {
            let mut st = c.prepare("SELECT path FROM roots")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let lib: Vec<(i64, String)> = {
            let mut st = c.prepare("SELECT id, path FROM documents WHERE in_library = 1 AND builtin = 0")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (did, dp) in lib {
            if !roots.iter().any(|r| path_under(&dp, r)) {
                c.execute("UPDATE documents SET in_library = 0, pinned = 0 WHERE id = ?1", rusqlite::params![did])?;
            }
        }
        c.pragma_update(None, "user_version", 5)?;
    }
    Ok(())
}

/// 驱动器相对毒路径：`X:name`——盘符冒号后直接跟非分隔符（PathBuf::from("D:").join(…) 的产物）
pub(crate) fn is_drive_rel(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] != b'\\' && b[2] != b'/'
}

/// 裸盘符目录：`D:`（无分隔符、无后继字符）
pub(crate) fn is_bare_drive(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// 'X:name…' → 'X:\name…'；其余原样
pub(crate) fn fix_drive_rel(p: &str) -> String {
    if is_drive_rel(p) {
        format!("{}\\{}", &p[0..2], &p[2..])
    } else {
        p.to_string()
    }
}
