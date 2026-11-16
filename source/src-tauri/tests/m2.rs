//! M2 功能测试：增量扫描（NFR-4）/ 保存冲突（FR-7.5）/ 库根登记（FR-10.4）。
//! 放 integration tests 而非 lib 内 mod，避免发布构建链接 rusqlite 测试依赖之外的摩擦。
use folio_app_lib::commands::{doc_full, save, scan};
use folio_db::Db;
use std::path::PathBuf;
use std::sync::Arc;

fn setup(name: &str) -> (Arc<Db>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("folio-m2-{}", name));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = Arc::new(Db::open(&dir.join("lib.db")).unwrap());
    (db, dir)
}

#[test]
fn scan_incremental_and_roots() {
    let (db, dir) = setup("scan");
    let docs = dir.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::write(docs.join("a.md"), "# A\n\n一").unwrap();
    std::fs::write(docs.join("b.md"), "# B\n\n二").unwrap();

    let r1 = scan(&db, docs.to_str().unwrap()).unwrap();
    assert_eq!(r1.inserted, 2);
    assert_eq!(r1.unchanged, 0);

    std::fs::write(docs.join("a.md"), "# A2\n\n一改过的").unwrap();
    std::fs::remove_file(docs.join("b.md")).unwrap();
    let r2 = scan(&db, docs.to_str().unwrap()).unwrap();
    assert_eq!(r2.updated, 1, "改动文件应重读重算");
    assert_eq!(r2.removed, 1, "删除文件应注销登记");

    let r3 = scan(&db, docs.to_str().unwrap()).unwrap();
    assert_eq!(r3.unchanged, 1, "第三遍全部命中增量跳过");
    assert_eq!(r3.inserted + r3.updated, 0);

    let roots = db.list_roots().unwrap();
    assert_eq!(roots.len(), 1, "扫描应幂等登记库根");
}

#[test]
fn save_conflict_then_force() {
    let (db, dir) = setup("conflict");
    let f = dir.join("c.md");
    std::fs::write(&f, "# 原始\n").unwrap();
    let opened = doc_full(&db, &f, true, true).unwrap();
    assert_eq!(opened.src, "# 原始\n");

    // mtime 以秒计：跨秒后模拟外部编辑器改动
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&f, "# 外部改动\n").unwrap();

    let err = save(&db, f.to_str().unwrap(), "# 我的编辑\n", false).unwrap_err();
    assert!(format!("{}", err).contains("CONFLICT"), "外部更新应触发冲突拦截");

    let ok = save(&db, f.to_str().unwrap(), "# 我的编辑\n", true).unwrap();
    assert_eq!(ok.src, "# 我的编辑\n");
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "# 我的编辑\n");
}

#[test]
fn open_does_not_join_library_but_scan_does() {
    // v3 语义：打开单个文件只进「最近打开」；把目录登记成库根并扫描才入库。
    let (db, dir) = setup("libsplit");
    let docs = dir.join("shelf");
    std::fs::create_dir_all(&docs).unwrap();
    let p = docs.join("a.md");
    std::fs::write(&p, "# A\n\n一").unwrap();

    let opened = doc_full(&db, &p, db.library_membership(&p).unwrap(), true).unwrap();
    assert!(!opened.meta.in_library, "单开文件不入库");
    assert_eq!(db.list_recents().unwrap().len(), 1, "但要有打开历史");

    // 内容没变（增量扫描会跳过重读），也要把这条补进库
    let rep = scan(&db, docs.to_str().unwrap()).unwrap();
    assert_eq!((rep.inserted, rep.updated, rep.unchanged), (0, 0, 1));
    let after = db.doc_by_path(&p.to_string_lossy()).unwrap();
    assert!(after.in_library, "扫到了就入库");
    assert_eq!(db.list_recents().unwrap().len(), 1, "入库不丢打开历史");

    // 移除库根 → 出库，但登记、进度、历史与磁盘都不动
    assert_eq!(db.remove_root(docs.to_str().unwrap()).unwrap(), 1);
    let demoted = db.doc_by_path(&p.to_string_lossy()).unwrap();
    assert!(!demoted.in_library && !demoted.pinned);
    assert_eq!(db.list_docs().unwrap().len(), 1);
    assert_eq!(db.list_recents().unwrap().len(), 1);
    assert!(p.exists());
}

#[test]
fn scan_switches_library_and_demotes_previous_members() {
    // v4 单库策略的真实路径：打开新目录 = 关闭旧目录，旧库成员降级为仅最近打开，
    // 且扫描不产生打开历史（扫描 ≠ 打开）。
    let (db, dir) = setup("switch");
    let (a, b) = (dir.join("libA"), dir.join("libB"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join("x.md"), "# X\n\n一").unwrap();
    std::fs::write(b.join("y.md"), "# Y\n\n二").unwrap();

    let r1 = scan(&db, a.to_str().unwrap()).unwrap();
    assert_eq!(r1.inserted, 1);
    assert!(r1.prev_root.is_none(), "第一次登记没有可关的旧库");
    assert_eq!(r1.prev_demoted, 0);

    let r2 = scan(&db, b.to_str().unwrap()).unwrap();
    assert_eq!(r2.prev_root.as_deref(), Some(a.to_str().unwrap()), "报出被切换掉的旧库");
    assert_eq!(r2.prev_demoted, 1, "旧库成员出库");
    assert_eq!(db.list_roots().unwrap(), vec![b.to_string_lossy().to_string()], "roots 永远只剩一行");

    let da = db.doc_by_path(&a.join("x.md").to_string_lossy()).unwrap();
    let db_ = db.doc_by_path(&b.join("y.md").to_string_lossy()).unwrap();
    assert!(!da.in_library, "旧库文档降级为仅最近打开（登记行仍在）");
    assert!(db_.in_library);

    // 切回 A：内容没变的 x.md 也要被 unchanged 分支重新补回库
    let r3 = scan(&db, a.to_str().unwrap()).unwrap();
    assert_eq!((r3.inserted, r3.updated, r3.unchanged), (0, 0, 1));
    assert_eq!(r3.prev_demoted, 1, "刚进来的 B 成员又被放出去");
    assert!(db.doc_by_path(&a.join("x.md").to_string_lossy()).unwrap().in_library);
    assert!(!db.doc_by_path(&b.join("y.md").to_string_lossy()).unwrap().in_library);

    assert_eq!(db.list_recents().unwrap().len(), 0, "三次扫描都不算打开");
    assert_eq!(db.list_docs().unwrap().len(), 2, "登记行一条不少");
    assert!(a.join("x.md").exists() && b.join("y.md").exists(), "磁盘文件不动");
}

#[test]
fn pinned_and_remove_keep_file() {
    let (db, dir) = setup("pin");
    let f = dir.join("p.md");
    std::fs::write(&f, "# P\n").unwrap();
    let m = db.upsert_document(&f, "# P\n", true).unwrap();
    assert!(!m.pinned);
    db.set_pinned(m.id, true).unwrap();
    assert!(db.list_docs().unwrap().iter().find(|d| d.id == m.id).unwrap().pinned);
    db.remove_doc(m.id).unwrap();
    assert!(db.list_docs().unwrap().iter().all(|d| d.id != m.id));
    assert!(f.exists(), "移除只删登记，不动磁盘");
}
