//! 临时探针：验证 0.2.1.114 的 FTS 维护判据（读连接/字节口径/触发/收缩）。
use folio_db::Db;
use std::path::Path;
use std::time::Instant;
fn main() {
    let p = std::env::args().nth(1).expect("db path");
    let db = Db::open(Path::new(&p)).expect("open db");
    let size = |p: &str| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    println!("file before {:.1} MB", size(&p) as f64 / 1048576.0);
    let mut ts = Vec::new();
    let mut stats = (0, 0, 0);
    for _ in 0..5 {
        let t = Instant::now();
        stats = db.fts_maintenance_stats().expect("stats");
        ts.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("stats blocks {:.2} MB body {:.2} MB segs {} | read-conn check avg {:.2} ms p95 {:.2} ms",
        stats.0 as f64 / 1048576.0, stats.1 as f64 / 1048576.0, stats.2,
        ts.iter().sum::<f64>() / ts.len() as f64, ts[4]);
    let t = Instant::now();
    let did = db.optimize_fts_if_stale().expect("optimize");
    println!("optimize={} {:.0} ms", did, t.elapsed().as_secs_f64() * 1000.0);
    let stats2 = db.fts_maintenance_stats().expect("stats2");
    println!("after optimize blocks {:.2} MB body {:.2} MB segs {}",
        stats2.0 as f64 / 1048576.0, stats2.1 as f64 / 1048576.0, stats2.2);
    let t = Instant::now();
    let vac = db.vacuum_if_bloated().expect("vacuum");
    println!("vacuum={} {:.0} ms", vac, t.elapsed().as_secs_f64() * 1000.0);
    println!("file after {:.1} MB", size(&p) as f64 / 1048576.0);
}
