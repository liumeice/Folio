//! folio-app — Tauri 2 壳：状态、插件（单实例 / 深度链接 / dialog）、命令编排。
//! 约定：所有阻塞 IO 进 spawn_blocking；错误统一压成 String 交给前端 toast。

pub mod commands;

use folio_core::{
    DocFull, DocMeta, Position, RecentDoc, RecentReport, ScanReport, SearchHit, SearchQuery, Settings,
};
use folio_db::Db;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri::{PhysicalPosition, PhysicalSize};

pub struct AppState {
    db: Arc<Db>,
    /// 冷启动命令行里的 folio:// 与文件路径（前端挂载后经 drain_pending 领取）
    pending: Mutex<Vec<String>>,
    /// FR-13.2：导出 PDF 互斥（CDP printToPDF 无取消接口，同一时刻只允许一趟打印）
    exporting: std::sync::atomic::AtomicBool,
}

fn errstr<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 启动几何钳制（2026-11-19 需求：窗口下沿不得撑到任务栏以下）。
/// conf 的 1280×820 在高缩放下可能高于「监视器工作区」（监视器去掉任务栏），
/// 且 config 的 center 是按整屏居中而不是按工作区，底边会被任务栏盖住。
/// 这里把工作区当硬上界（留 12px 边距）收缩窗口尺寸，并按工作区重新居中。
/// 最小尺寸 1000×620 由 tao 约束兜底：极小屏幕上宁可触底也不破 minWidth/minHeight。
#[cfg(desktop)]
fn clamp_window_to_work_area(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let wa = monitor.work_area();
    let Ok(size) = win.outer_size() else { return };
    let margin = 12u32;
    let max_w = wa.size.width.saturating_sub(margin * 2);
    let max_h = wa.size.height.saturating_sub(margin * 2);
    let (w, h) = (size.width.min(max_w), size.height.min(max_h));
    if w != size.width || h != size.height {
        let _ = win.set_size(PhysicalSize::new(w, h));
    }
    let x = wa.position.x + ((wa.size.width.saturating_sub(w)) as i32) / 2;
    let y = wa.position.y + ((wa.size.height.saturating_sub(h)) as i32) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// deep link / 文件关联的统一载荷。协议契约（评审 v1·#9 定稿）：
/// folio://open?doc=<slug>&sec=<标题文本>（sec 可选；doc 也可传绝对路径）
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub slug: Option<String>,
    pub path: Option<String>,
    pub sec: Option<String>,
}

fn urldecode(s: &str) -> String {
    urlencoding::decode(s).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

fn parse_folio(url: &str) -> Option<OpenRequest> {
    let tail = url.strip_prefix("folio://")?;
    let (head, qs) = tail.split_once('?').unwrap_or((tail, ""));
    let mut req = OpenRequest { slug: None, path: None, sec: None };
    // 形态 A：folio://open?doc=slug&sec=…
    // 形态 B（容错旧文案）：folio://doc/<slug>
    if head.eq_ignore_ascii_case("open") {
        for kv in qs.split('&').filter(|s| !s.is_empty()) {
            if let Some((k, v)) = kv.split_once('=') {
                match k {
                    "doc" => {
                        let v = urldecode(v);
                        if v.contains('\\') || v.contains('/') || v.ends_with(".md") {
                            req.path = Some(v);
                        } else {
                            req.slug = Some(v);
                        }
                    }
                    "sec" => req.sec = Some(urldecode(v)),
                    _ => {}
                }
            }
        }
    } else if let Some(slug) = head.strip_prefix("doc/") {
        req.slug = Some(urldecode(slug));
    } else {
        return None;
    }
    (req.slug.is_some() || req.path.is_some()).then_some(req)
}

fn emit_open_request(app: &AppHandle, raw: &str) {
    if let Some(req) = parse_folio(raw) {
        let _ = app.emit("folio-open", req);
    } else if folio_fs::is_supported(std::path::Path::new(raw)) {
        let _ = app.emit(
            "folio-open",
            OpenRequest { slug: None, path: Some(raw.to_string()), sec: None },
        );
    }
}

// ── commands ────────────────────────────────────────────────

/// 所有重活的统一入口：clone Arc、进阻塞线程池、双层错误折叠成 String。
/// （比 macro_rules 好在：闭包参数类型由签名确定，且无宏卫生问题）
/// 最近一次交互式 DB 命令的时刻（unix 毫秒）。后台维护线程据此「安静才干活」，
/// 避免 VACUUM/FTS optimize 长事务占写锁期间把用户操作憋死（2026-11-19 垃圾桶假死回归）。
static LAST_DB_USE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn spawn_db<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Arc<Db>) -> folio_core::Result<T> + Send + 'static,
) -> Result<T, String> {
    LAST_DB_USE_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || f(&db))
        .await
        .map_err(errstr)?
        .map_err(errstr)
}

#[tauri::command]
async fn list_docs(state: State<'_, AppState>) -> Result<Vec<DocMeta>, String> {
    spawn_db(&state, |db| db.list_docs()).await
}

/// 是否本应用草稿路径（appdata/drafts/*，词法规范化比对）。
/// 用途：未保存的新建文档不进「最近打开」（需求方 2026-11-16 定夺）。
pub(crate) fn is_draft_path(app: &AppHandle, raw: &str) -> bool {
    let Ok(drafts) = app.path().app_data_dir().map(|d| d.join("drafts")) else { return false };
    let dl = drafts.to_string_lossy().to_lowercase().replace('\\', "/");
    let dl = dl.trim_end_matches('/');
    let pl = raw.to_lowercase().replace('\\', "/");
    pl.len() > dl.len() && pl.starts_with(dl) && pl.as_bytes()[dl.len()] == b'/'
}

#[tauri::command]
async fn open_doc(app: AppHandle, path: String, state: State<'_, AppState>) -> Result<DocFull, String> {
    reject_dotdot(&path)?; // SEC-02：词法越权门槛（详见 guarded_path 注释）
    // v3：打开单个文件不再入库。是否库成员按已登记库根判定；打开历史由 doc_full 统一记。
    // 草稿例外：未保存的新建文档不写打开历史（另存为走真实路径后正常记录）。
    let record = !is_draft_path(&app, &path);
    spawn_db(&state, move |db| {
        let p = std::path::Path::new(&path);
        let in_library = db.library_membership(p)?;
        commands::doc_full(db, p, in_library, record)
    })
    .await
}

#[tauri::command]
async fn open_by_slug(slug: String, state: State<'_, AppState>) -> Result<DocFull, String> {
    spawn_db(&state, move |db| commands::open_by_slug(db, &slug)).await
}

#[tauri::command]
async fn save_doc(path: String, content: String, force: Option<bool>, state: State<'_, AppState>) -> Result<DocFull, String> {
    reject_dotdot(&path)?; // SEC-02
    spawn_db(&state, move |db| commands::save(db, &path, &content, force.unwrap_or(false))).await
}

/// 源码格式化结果（与前端 `FormatResult` 一一对应；大纲行号按**格式化后**文本重算）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatReply {
    text: String,
    changed: bool,
    changed_lines: usize,
    outline: Vec<folio_core::OutlineItem>,
    sec_count: i64,
    word_count: i64,
    head_count: i64,
    /// 与 folio-db::DocUpsert::from_source 同口径的标题（首行 "# "）；无则 null（前端保留旧标题）
    title: Option<String>,
    warnings: Vec<String>,
}

/// 源码自动格式化（《Folio 源码自动格式化方案》§4.2）：
/// 纯计算进 spawn_blocking，不碰 DB、不写盘——结果由前端应用到编辑器，
/// 落盘仍走用户显式「保存」（手动保存纪律，程序不做认知外的写盘）。
#[tauri::command]
async fn format_markdown(
    src: String,
    options: Option<folio_core::format::FormatOptions>,
) -> Result<FormatReply, String> {
    let opt = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let r = folio_core::format::format_markdown(&src, &opt);
        let (word_count, head_count, sec_count) = folio_core::markdown::stats(&r.text);
        // 标题口径与 folio-db 的登记逻辑一致：首个行首 "# " 行（不跳围栏，保持既有行为）
        let title = r
            .text
            .lines()
            .find_map(|l| l.trim_start().strip_prefix("# ").map(|s| s.trim().to_string()));
        FormatReply {
            outline: commands::outline_of(&r.text),
            text: r.text,
            changed: r.changed,
            changed_lines: r.changed_lines,
            sec_count,
            word_count,
            head_count,
            title,
            warnings: r.warnings,
        }
    })
    .await
    .map_err(errstr)
}

/// schema v2：置顶开关 / 从库移除（不动磁盘）/ 库根管理
#[tauri::command]
async fn set_pinned(id: i64, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    spawn_db(&state, move |db| db.set_pinned(id, on)).await
}

/// schema v3：库成员开关（右键「从库移除」）。登记行保留，出库时取消置顶；磁盘文件不动。
#[tauri::command]
async fn set_in_library(id: i64, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    spawn_db(&state, move |db| db.set_in_library(id, on)).await
}

/// schema v3：打开历史（时间倒序，不限量）。与库成员互不隶属。
#[tauri::command]
async fn list_recents(state: State<'_, AppState>) -> Result<Vec<RecentDoc>, String> {
    spawn_db(&state, |db| db.list_recents()).await
}

/// 从历史移除一条。返回 true = 该文档既不在库也非内置，登记行已连带回收（进度/索引一并清）。
#[tauri::command]
async fn remove_recent(id: i64, state: State<'_, AppState>) -> Result<bool, String> {
    spawn_db(&state, move |db| db.remove_recent(id)).await
}

/// 清空打开历史：只删历史 + 失去归属的登记；库成员与内置文档的进度不受影响，磁盘不动。
#[tauri::command]
async fn clear_recents(state: State<'_, AppState>) -> Result<RecentReport, String> {
    spawn_db(&state, |db| db.clear_recents()).await
}

#[tauri::command]
async fn list_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    spawn_db(&state, |db| db.list_roots()).await
}

/// 移除库根：只被该根覆盖的库成员一并出库（不动磁盘与进度），返回出库条数
#[tauri::command]
async fn remove_root(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    spawn_db(&state, move |db| db.remove_root(&path)).await
}

/// read_file 体积上限（导入配置是 KB 级；防超大文件把整篇读进 String 打爆内存）
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

/// SEC-02（纵深防御）路径守门：
/// ① 拒绝任何含 `..`（ParentDir）分量的路径——对话框正常产物里不会有它，出现的即为构造；
/// ② 父目录 canonicalize 后重拼文件名——"写的路径"与"实际打开的路径"不再因符号链接外的
///    词法游戏分离。canonicalize 失败（父目录不存在等）维持原路径交给 IO 层报错。
/// 注意：路径最终仍出自应用内选择对话框（§8.6 产品决议），"完全由 Rust 决定路径"的
/// 意图化改造（export_config/import_config 走原生对话框）留待后续；见修改报告 SEC-02 节。
/// 只拒绝词法 `..` 分量（不做 canonicalize——登记键存的是用户可见路径，
/// 规范化会改写出 `\\?\` 前缀导致同文件两个登记键，这里刻意保守）。
pub(crate) fn reject_dotdot(raw: &str) -> std::result::Result<(), String> {
    if std::path::Path::new(raw)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径包含 ..，已拒绝".into());
    }
    Ok(())
}

fn guarded_path(raw: &str) -> std::result::Result<std::path::PathBuf, String> {
    reject_dotdot(raw)?;
    let p = std::path::PathBuf::from(raw);
    if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
        if let Ok(can) = parent.canonicalize() {
            return Ok(can.join(name));
        }
    }
    Ok(p)
}

/// 构造 CDP `Page.printToPDF` 的 params JSON。
/// A4 纵向、上下 15mm / 左右 12mm 页边距（英寸=mm/25.4）、打印背景色、页眉页脚关。
/// **`generateDocumentOutline:true` 是书签的开关**——内核据正文 h1–h6 生成 PDF 文档大纲树（FR-13.2 的核心需求）。
#[cfg(windows)]
fn pdf_print_params_json() -> String {
    let mut m = serde_json::Map::new();
    let ins = |mm: f64| mm / 25.4; // 毫米 → 英寸
    m.insert("printBackground".into(), true.into());
    m.insert("paperWidth".into(), (8.27f64).into());  // A4 8.27in
    m.insert("paperHeight".into(), (11.69f64).into()); // A4 11.69in
    m.insert("marginTop".into(), ins(15.0).into());
    m.insert("marginBottom".into(), ins(15.0).into());
    m.insert("marginLeft".into(), ins(12.0).into());
    m.insert("marginRight".into(), ins(12.0).into());
    m.insert("preferCSSPageSize".into(), false.into());
    m.insert("displayHeaderFooter".into(), false.into());
    m.insert("generateDocumentOutline".into(), true.into()); // ★ 大纲→书签
    m.insert("transferMode".into(), "ReturnAsBase64".into());
    serde_json::Value::Object(m).to_string()
}

/// 把 &str 拷进调用方持有的 Vec<u16>（补 null），返回指向它的 PCWSTR（借用了 buf，故 buf 必须活到调用结束）。
#[cfg(windows)]
fn pcstr_in(buf: &mut Vec<u16>, s: &str) -> windows_core::PCWSTR {
    buf.clear();
    buf.extend(s.encode_utf16());
    buf.push(0);
    windows_core::PCWSTR(buf.as_ptr())
}

/// 解析 `#RRGGBB`（前端传主题底色用；失败回退白纸）。
#[cfg(windows)]
fn parse_hex_color(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 { return None; }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

/// 导出当前阅读视图为 PDF（FR-13.2，含大纲书签）。
///
/// 路线：WebView2 进程内 DevTools 协议 `Page.printToPDF`（`CallDevToolsProtocolMethod`），
/// 而非官方 `PrintToPdf`——后者不支持文档大纲，而本需求的书签正是要靠 `generateDocumentOutline`
/// 从正文 h1–h6 生成。内核支持性已由 `source/_cdp_pdfpoc.mjs` 活体 POC 验证（产物含 /Outlines+/Title）。
/// 版式（A4 / 边距 / 隐藏窗口壳）全在 app.css 的 `@media print`，这里只管协议与落盘。
/// `bg_color`（`#RRGGBB`）= 阅读窗底色：导出期间临时把 WebView2 页面衬底设成它（页边距环带
/// 只认衬底，CSS 画不进去——2026-11-17 二分实测），完成后还原窗口原色，屏幕侧零影响。
/// 全程互斥（`AppState.exporting`）：CDP 打印无取消接口，一次只许一趟。
#[cfg(windows)]
#[tauri::command]
async fn export_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    bg_color: Option<String>,
) -> Result<(), String> {
    use base64::Engine as _;
    if state.exporting.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("上一次导出尚未完成".into());
    }
    let win = app.get_webview_window("main").ok_or_else(|| "找不到主窗口".to_string())?;
    let params = pdf_print_params_json();
    let (pr, pg, pb) = bg_color.as_deref().and_then(parse_hex_color).unwrap_or((255, 255, 255));
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    // with_webview 把闭包投递到主线程执行（COM 必须在其创建线程），执行完即返回；
    // completed 回调稍后也在主线程触发，把 CDP 结果 JSON 经 tx 送回。
    let dispatch = win.with_webview(move |wv| {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_COLOR, ICoreWebView2Controller2};
        use windows_core::Interface as _;
        let controller = wv.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(c) => c,
            Err(e) => { let _ = tx.send(Err(errstr(e))); return; }
        };
        // 黑边框真凶（2026-11-17 二分实测坐实）：tauri.conf 的窗口底色 #080D18 被 wry 设为
        // WebView2 DefaultBackgroundColor；Chromium printToPDF(printBackground:true) 把这个
        // 渲染器级衬底逐页铺——页边距环带（无任何元素可画）露出的就是它。CSS 打印规则管不到
        // 这一层（此前所有 CSS 修复无效的原因）。对策：导出期间临时置白，完成/失败后还原，
        // 屏幕侧零影响（应用自身始终铺满不露衬底）。
        let ctl2 = match controller.cast::<ICoreWebView2Controller2>() {
            Ok(c) => c,
            Err(e) => { let _ = tx.send(Err(errstr(e))); return; }
        };
        let mut orig = COREWEBVIEW2_COLOR { A: 255, R: 255, G: 255, B: 255 };
        let _ = unsafe { ctl2.DefaultBackgroundColor(&mut orig) };
        if let Err(e) = unsafe { ctl2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 255, R: pr, G: pg, B: pb }) } {
            let _ = tx.send(Err(format!("设置页面衬底失败：{}", e)));
            return;
        }
        let ctl_h = ctl2.clone();
        let orig_h = COREWEBVIEW2_COLOR { A: orig.A, R: orig.R, G: orig.G, B: orig.B };
        let tx_cb = tx.clone(); // 完成回调这一支
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |status: windows_core::Result<()>, result_json: String| -> windows_core::Result<()> {
                let _ = unsafe { ctl_h.SetDefaultBackgroundColor(orig_h) }; // 打印结束——还原窗口底色
                let _ = match status {
                    Ok(()) => tx_cb.send(Ok(result_json)),
                    Err(e) => tx_cb.send(Err(errstr(e))),
                };
                Ok(())
            },
        ));
        let mut mbuf = Vec::new();
        let mut pbuf = Vec::new();
        let name = pcstr_in(&mut mbuf, "Page.printToPDF");
        let args = pcstr_in(&mut pbuf, &params);
        // 提交失败 = handler 永远不会触发 → 先还原衬底再就地送错，否则外层只能等到断链
        if let Err(e) = unsafe { core.CallDevToolsProtocolMethod(name, args, &handler) } {
            let _ = unsafe { ctl2.SetDefaultBackgroundColor(orig) };
            let _ = tx.send(Err(format!("打印接口调用失败：{}", e)));
        }
    });
    if let Err(e) = dispatch {
        state.exporting.store(false, std::sync::atomic::Ordering::SeqCst);
        return Err(format!("无法访问渲染进程：{}", e));
    }
    // 等回调（阻塞在 spawn_blocking 线程，不占 async 执行器）
    let recv = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(errstr)?;
    state.exporting.store(false, std::sync::atomic::Ordering::SeqCst);
    let json = recv.map_err(|_| "导出超时：渲染进程未返回 PDF（请重试）".to_string())??;
    // CDP 结果 {"data":"<base64>"}；解析失败/无 data 字段一律当错误，把原始片段带回（截断）
    let val: serde_json::Value = serde_json::from_str(&json)
        .map_err(|_| format!("PDF 返回解析失败：{}", trunc(&json, 120)))?;
    let b64 = val.get("data").and_then(|d| d.as_str())
        .ok_or_else(|| format!("导出失败：渲染器未产出 PDF（{}）", trunc(&json, 120)))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(errstr)?;
    let p = guarded_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(errstr)?; }
        std::fs::write(&p, &bytes).map_err(errstr)
    })
    .await
    .map_err(errstr)?
    .map_err(errstr)
}

/// 非 Windows 平台占位（本需求仅 Windows）；保持命令签名一致，运行时报错即可。
#[cfg(not(windows))]
#[tauri::command]
async fn export_pdf(_app: AppHandle, _state: State<'_, AppState>, _path: String, _bg_color: Option<String>) -> Result<(), String> {
    Err("导出 PDF 目前仅在 Windows 平台提供".into())
}

/// 安全截断（避免把超长 base64 或异常 payload 整段甩进错误串）。
fn trunc(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { s.chars().take(n).collect::<String>() + "…" }
}

/// 导出等通用写出（路径由前端 save 对话框确定，FR-13.1）
#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    let p = guarded_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || folio_fs::write_text(&p, &content))
        .await
        .map_err(errstr)?
        .map_err(errstr)
}

/// 导出 HTML 图片随行（FR-13.1，需求方 2026-11-17）：本地按路径复制、远程 Rust 侧下载
/// （webview CSP 只放行 IPC，前端 fetch 不了任意 https），统一落 <HTML 同级>/images/。
/// 路径守卫与 write_file 同口径（拒 `..`、父目录存在则 canonical 化）；
/// 逐图成败在 commands.rs（无 tauri 依赖，可单测）。
#[tauri::command]
async fn export_images(
    html_path: String,
    items: Vec<commands::ImageRef>,
) -> Result<Vec<commands::ImageOut>, String> {
    let p = guarded_path(&html_path)?;
    Ok(commands::run_export_images(&p, items).await)
}

/// 导入等通用读文本（不受扩展名白名单限制；路径由前端 open 对话框确定）
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    let p = guarded_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(u64::MAX);
        if size > MAX_READ_BYTES {
            return Err("文件过大（上限 16MB），拒绝读取".to_string());
        }
        folio_fs::read_text(&p).map_err(errstr)
    })
    .await
    .map_err(errstr)?
}

/// md 文档本地图片解析（FR-2.1）：返回磁盘绝对路径并动态放行 asset 协议
#[tauri::command]
async fn resolve_image(
    app: AppHandle,
    doc_path: String,
    url: String,
) -> Result<Option<String>, String> {
    let found = tauri::async_runtime::spawn_blocking(move || commands::resolve_image(&doc_path, &url))
        .await
        .map_err(errstr)?;
    if let Some(p) = &found {
        // 空 scope 起步：只把真实解析命中的文件加入 asset 白名单（不放通配）
        use tauri::Manager;
        let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(p));
    }
    Ok(found)
}

/// 批量图片解析（性能 P1-7 + P2-3）：一次 IPC 解析整篇文档的本地图片并附带头部解析的像素尺寸；
/// 返回与 urls 同序数组，元素 = (绝对路径, 宽, 高)，0 尺寸表示格式未知。
#[tauri::command]
async fn resolve_images(
    app: AppHandle,
    doc_path: String,
    urls: Vec<String>,
) -> Result<Vec<Option<(String, u32, u32)>>, String> {
    let found = tauri::async_runtime::spawn_blocking(move || {
        urls.iter()
            .map(|u| {
                commands::resolve_image(&doc_path, u).map(|p| {
                    let (w, h) = folio_fs::img_dims(std::path::Path::new(&p)).unwrap_or((0, 0));
                    (p, w, h)
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(errstr)?;
    use tauri::Manager;
    for it in found.iter().flatten() {
        let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&it.0));
    }
    Ok(found)
}

#[tauri::command]
async fn toggle_task(path: String, nth: i64, state: State<'_, AppState>) -> Result<DocFull, String> {
    reject_dotdot(&path)?; // SEC-02
    spawn_db(&state, move |db| commands::toggle_task(db, &path, nth)).await
}

#[tauri::command]
async fn scan_folder(root: String, state: State<'_, AppState>) -> Result<ScanReport, String> {
    reject_dotdot(&root)?; // SEC-02
    spawn_db(&state, move |db| commands::scan(db, &root)).await
}

#[tauri::command]
async fn search(query: SearchQuery, state: State<'_, AppState>) -> Result<Vec<SearchHit>, String> {
    spawn_db(&state, move |db| commands::search(db, &query)).await
}

#[tauri::command]
async fn save_position(
    doc_id: i64,
    position: Position,
    state: State<'_, AppState>,
) -> Result<(), String> {
    spawn_db(&state, move |db| commands::save_position(db, doc_id, &position)).await
}

#[tauri::command]
async fn get_positions(state: State<'_, AppState>) -> Result<Vec<(i64, Position)>, String> {
    spawn_db(&state, |db| db.positions()).await
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    spawn_db(&state, |db| db.settings()).await
}

#[tauri::command]
async fn set_settings(settings: Settings, state: State<'_, AppState>) -> Result<(), String> {
    spawn_db(&state, move |db| db.set_settings(&settings)).await
}

/// 冷启动 pending（folio:// 或关联文件）由前端挂载后领取一次
#[tauri::command]
fn drain_pending(state: State<'_, AppState>) -> Vec<String> {
    state.pending.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

/// 拖放路径判定（FR-1.2：文件→打开，目录→扫描登记）
#[tauri::command]
fn path_kind(path: String) -> &'static str {
    let p = std::path::Path::new(&path);
    if p.is_dir() { "dir" } else if p.is_file() { "file" } else { "missing" }
}

// ── 应用内选择对话框的数据源（UI 规范 v1.1 §8.6：2026-11-16 起不再调起系统原生选择窗）──

#[derive(Serialize)]
struct FsEntryJson {
    name: String,
    path: String,
}
#[derive(Serialize)]
struct FsFileJson {
    name: String,
    path: String,
    mtime: i64,
    supported: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirListingJson {
    parent: Option<String>,
    dirs: Vec<FsEntryJson>,
    files: Vec<FsFileJson>,
}

/// 目录列举（只读一层）；path 传 folio_fs::MY_PC（"::my-pc"）= 「此电脑」盘符节点
#[tauri::command]
async fn list_dir(path: String) -> Result<DirListingJson, String> {
    let l = tauri::async_runtime::spawn_blocking(move || folio_fs::list_dir(&path))
        .await
        .map_err(errstr)?
        .map_err(errstr)?;
    Ok(DirListingJson {
        parent: l.parent,
        dirs: l.dirs.into_iter().map(|folio_fs::FsEntry(n, p)| FsEntryJson { name: n, path: p }).collect(),
        files: l.files.into_iter().map(|f| FsFileJson { name: f.name, path: f.path, mtime: f.mtime, supported: f.supported }).collect(),
    })
}

/// 确认框「里面有 M 篇」的递归计数（只统计，不登记；上限 5 万防呆）
#[tauri::command]
async fn md_count(path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || folio_fs::count_md(&path, 50_000))
        .await
        .map_err(errstr)
}

/// （new_doc 命令已删除，2026-11-16 审查整改 STD-01：前端零调用——新建走 new_doc_draft 草稿线。
///  folio_fs::new_doc 仍被 new_doc_draft 复用。）

/// 新建文档草稿：落在应用数据目录 drafts/（不进库不进树），首次保存后由 delete_scratch 清理
#[tauri::command]
async fn new_doc_draft(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(errstr)?.join("drafts");
    let dir = dir.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        folio_fs::new_doc(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(errstr)?
}

/// p 是否严格位于 root 之下（root 自身不算）。两侧都应已 canonicalize（无 `..`、真实大小写）。
fn within_dir(root: &std::path::Path, p: &std::path::Path) -> bool {
    p != root && p.starts_with(root)
}

/// 删除草稿临时文件：路径必须位于本应用 appdata/drafts 之下（防误删用户文件）。
/// SEC-02 修复：旧实现用**原始路径**做词法 `starts_with`，`drafts\..\..\目标` 能先匹配
/// `…\drafts` 前缀、再由 remove_file 沿 `..` 出界删除任意文件。现两侧 canonicalize 后比对。
/// CON-04 修复：连带回收该路径的登记行（历史/进度/FTS），"最近打开"不再留指向死文件的条目。
#[tauri::command]
async fn delete_scratch(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(errstr)?.join("drafts");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let canon_root = root.canonicalize().map_err(errstr)?;
        let p = std::path::PathBuf::from(&path);
        // 文件可能已被手动删除：canonicalize 失败时规范化父目录再拼文件名（文件名部分不含 `..` 已由守门保证）
        let resolved = p.canonicalize().unwrap_or_else(|_| {
            p.parent()
                .and_then(|d| d.canonicalize().ok())
                .and_then(|d| p.file_name().map(|f| d.join(f)))
                .unwrap_or_else(|| p.clone())
        });
        if !within_dir(&canon_root, &resolved) {
            return Err("只能清理草稿临时文件".into());
        }
        if resolved.is_file() {
            let _ = std::fs::remove_file(&resolved);
        }
        let key = p.to_string_lossy().to_lowercase();
        if let Ok(meta) = db.doc_by_path(&key) {
            if !meta.in_library && !meta.builtin {
                let _ = db.remove_doc(meta.id);
            }
        }
        Ok(())
    })
    .await
    .map_err(errstr)?
}

// ── run ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial: Vec<String> = std::env::args().skip(1).collect();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // deep-link 插件必须在 setup 之前注册：setup 里 app.deep_link() 取其托管状态，
        // 缺 init 会在运行时 panic（“state() called before manage()”，cargo check 无法发现）
        .plugin(tauri_plugin_deep_link::init())
        .setup(move |app| {
            // 启动即钳制几何，早于窗口首次可见的绘制帧，用户看不到跳变
            #[cfg(desktop)]
            clamp_window_to_work_area(app);
            let data_dir = app.path().app_data_dir().map_err(errstr)?;
            let db = Arc::new(Db::open(&data_dir.join("folio.db")).map_err(errstr)?);
            // 草稿遗留清扫（2026-11-16 需求定夺的收尾）：旧会话把未保存的「未命名文档」记进过
            // 最近打开——新开的草稿已不写历史（open_doc record=false），这里把历史行连带登记一并回收。
            {
                let dl = data_dir.join("drafts").to_string_lossy().to_lowercase().replace('\\', "/");
                let dl = dl.trim_end_matches('/');
                if let Ok(docs) = db.list_docs() {
                    for m in docs {
                        let pl = m.path.to_lowercase().replace('\\', "/");
                        let in_drafts = pl.len() > dl.len() && pl.starts_with(dl) && pl.as_bytes()[dl.len()] == b'/';
                        if in_drafts && !m.in_library && !m.builtin {
                            let _ = db.remove_doc(m.id);
                        }
                    }
                }
            }
            // FR-4.5：内置文档（欢迎页 + 使用指南，后者挂在「帮助」菜单）。v3 起它们既不是库成员、
            // 也不被历史清理回收（builtin 标记），所以按「这一条登记在不在」判定，而不是「库是否为空」
            // ——后者会让重新安装后不再出现。文件只在不存时解出，用户在数据目录里的改动不会被覆盖。
            for (name, content) in [
                ("welcome.md", include_str!("../../src/assets/welcome.md")),
                ("guide.md", include_str!("../../src/assets/guide.md")),
            ] {
                let p = data_dir.join(name);
                if !p.exists() {
                    let _ = std::fs::write(&p, content);
                }
                if db.doc_by_path(&p.to_string_lossy()).is_err() {
                    if let Ok(src) = folio_fs::read_md(&p) {
                        let _ = db.upsert_builtin_document(&p, &src);
                    }
                }
            }
            // P1-6：后台维护一轮库：FTS 段合并 → 膨胀 VACUUM（条件触发）→ WAL 收拢。
            // 2026-11-19 回归修复：旧实现固定启动 3s 后开工，大库上 optimize/VACUUM 会
            // 长时间持有 DB 写锁——期间用户点「清空最近打开」/保存，命令在互斥锁上排队，
            // 表现为"点了没反应、列表不清"，维护结束才补上（垃圾桶假死）。
            // 现在：连续 2 分钟没有交互式 DB 命令才开工；每一步之间复核安静期，
            // 被用户打断则推迟到下一个安静窗口。WAL 日常收拢有 wal_autocheckpoint=256 兜底，
            // optimize/VACUUM 本就是条件触发，本轮错过无害。
            let db_maint = db.clone();
            // 把"现在"当作最近一次活动：启动命令与欢迎页登记还没走 spawn_db 计数，
            // 否则维护线程会在开机第一秒就误判安静并抢跑。
            LAST_DB_USE_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
            std::thread::Builder::new()
                .name("folio-db-maint".into())
                .spawn(move || {
                    const QUIET_MS: u64 = 120_000;
                    let quiet = || {
                        now_ms().saturating_sub(LAST_DB_USE_MS.load(std::sync::atomic::Ordering::Relaxed)) >= QUIET_MS
                    };
                    let wait_quiet = || {
                        while !quiet() {
                            std::thread::sleep(std::time::Duration::from_secs(10));
                        }
                    };
                    // 逐步复核安静期：上一步耗时期间用户回来了，后续步骤顺延到下一个窗口
                    wait_quiet();
                    let _ = db_maint.optimize_fts_if_stale();
                    wait_quiet();
                    let _ = db_maint.vacuum_if_bloated();
                    wait_quiet();
                    let _ = db_maint.checkpoint();
                })
                .ok();
            app.manage(AppState { db, pending: Mutex::new(initial.clone()), exporting: std::sync::atomic::AtomicBool::new(false) });

            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    emit_open_request(&handle, url.as_str());
                }
            });
            // Windows/Linux：首次运行把 scheme 写进注册表（NSIS 安装时也会登记；此处兜底 dev 模式）
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register_all();
            }
            // md 文件关联图标补丁（2026-11-17，设计稿 prototype/folio/index.html）：NSIS 模板把
            // ProgID（Folio.md，见 tauri.conf fileAssociations.name）的 DefaultIcon 写死为 exe,0，
            // WiX 模板则不写 DefaultIcon——两者都只会显示 exe 图标。这里改指随装资源
            // folio-md-icon.ico：HKCU 类表逐值优先于 HKLM，per-machine 安装同样生效；
            // 源码直跑 / dev 无该资源时 exists() 过滤，跳过不改注册表。
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let ico = ["icons/folio-md-icon.ico", "folio-md-icon.ico"].iter().find_map(|rel| {
                    app.path()
                        .resolve(*rel, tauri::path::BaseDirectory::Resource)
                        .ok()
                        .filter(|p| p.exists())
                });
                if let Some(p) = ico {
                    let data = format!("{},0", p.display());
                    let _ = std::process::Command::new("reg")
                        .args(["add", r"HKCU\Software\Classes\Folio.md\DefaultIcon", "/ve", "/d", &data, "/f"])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
            Ok(())
        });

    // SEC-03：导航白名单兜底——正文链接的 scheme 拦截在 Reader（前端），但任何**其它途径**
    // 发起的主框架导航（注入脚本改 location、未来新代码漏网）都必须被 Rust 侧最后一道闸拦下：
    // 只放行应用自身 origin（dev=http://localhost:5173，打包=*.tauri / http://tauri.localhost）与 about:blank。
    // 插件级 on_navigation 钩子会被 tauri 挂到每个 webview 的导航判定链上（含 config 创建的窗口）。
    builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("navguard")
            .on_navigation(|_webview, url| {
                match url.scheme() {
                    "about" => true,
                    "http" | "https" | "tauri" => {
                        matches!(url.host_str(), Some("localhost") | Some("tauri.localhost"))
                    }
                    _ => false, // data: / file: / javascript: / 远程主机 / 未知 scheme
                }
            })
            .build(),
    );

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二实例（含被 folio:// 唤起、被双击文件唤起）转发给主实例
            for arg in argv.iter().skip(1) {
                emit_open_request(app, arg);
            }
            let _ = app.get_webview_window("main").map(|w| {
                let _ = w.unminimize();
                let _ = w.set_focus();
            });
        }));
    }

    builder
        .on_window_event(|window, event| {
            // UI-02：Alt+F4 / 任务栏「关闭窗口」/ 系统关机不再绕过脏检查——
            // 拦截默认关闭，广播给前端；前端落位、确认（必要时弹询问框）后调 destroy
            // （destroy 不触发 CloseRequested，不会回流成死循环；取消则窗口原地不动）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_docs,
            open_doc,
            open_by_slug,
            save_doc,
            format_markdown,
            toggle_task,
            scan_folder,
            search,
            save_position,
            get_positions,
            get_settings,
            set_settings,
            drain_pending,
            path_kind,
            list_dir,
            md_count,
            new_doc_draft,
            delete_scratch,
            set_pinned,
            set_in_library,
            list_recents,
            remove_recent,
            clear_recents,
            list_roots,
            remove_root,
            write_file,
            read_file,
            resolve_image,
            resolve_images,
            export_pdf,
            export_images
        ])
        .run(tauri::generate_context!())
        .expect("Folio 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_open_form() {
        let r = parse_folio("folio://open?doc=rust-notes&sec=%E7%AC%AC%201%E7%AB%A0").unwrap();
        assert_eq!(r.slug.as_deref(), Some("rust-notes"));
        assert_eq!(r.sec.as_deref(), Some("第 1章"));
    }

    #[test]
    fn reject_dotdot_blocks_lexical_traversal() {
        // SEC-02：对话框产物路径不含 ..；含 .. 的一律构造路径，拒
        assert!(reject_dotdot("C:\\Users\\x\\AppData\\drafts\\..\\..\\evil.md").is_err());
        assert!(reject_dotdot("D:/docs/a.md").is_ok());
        assert!(reject_dotdot("D:\\docs\\子目录\\b.md").is_ok());
    }

    #[test]
    fn guarded_path_canonicalizes_parent_but_keeps_plain_when_absent() {
        let dir = std::env::temp_dir();
        let real = guarded_path(dir.join("folio-guard-test.md").to_str().unwrap()).unwrap();
        assert!(real.components().any(|c| matches!(c, std::path::Component::Prefix(_))) || real.starts_with(&dir));
        assert!(guarded_path("D:\\不存在盘\\x\\a.md").is_ok()); // 父目录不存在：保守放行给 IO 层报错
        assert!(guarded_path("..\\a.md").is_err());
    }

    #[test]
    fn within_dir_requires_strict_containment() {
        use std::path::Path;
        let root = Path::new("C:\\app\\drafts");
        assert!(within_dir(root, &Path::new("C:\\app\\drafts\\a.md")));
        assert!(!within_dir(root, Path::new("C:\\app\\drafts2\\a.md")), "同级前缀目录不算在内");
        assert!(!within_dir(root, root), "目录自身不许被当作草稿文件删除");
    }

    #[test]
    fn parse_path_form_and_legacy() {
        let r = parse_folio("folio://open?doc=D:\\docs\\a.md").unwrap();
        assert_eq!(r.path.as_deref(), Some("D:\\docs\\a.md"));
        let r2 = parse_folio("folio://doc/guide").unwrap();
        assert_eq!(r2.slug.as_deref(), Some("guide"));
        assert!(parse_folio("https://not-folio").is_none());
        assert!(parse_folio("folio://wat").is_none());
    }
}
