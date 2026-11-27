//! 活动文档的外部修改监听（《Folio-外部修改刷新方案-20261127》）。
//!
//! 只监听当前活动文档，监听**父目录**而不是文件本身：VS Code / Typora 等编辑器
//! 常用「临时文件 + rename」落盘，单文件 watch 会随 inode 消失而失效。
//! 事件去抖 250ms 后重新 stat，再向前端广播 `folio-file-changed`。
//! 前端据 mtime + size 与当前登记值比较，自行过滤 Folio 保存产生的回声。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    pub path: String,
    pub exists: bool,
    pub mtime: i64,
    pub size: u64,
}

/// 持有 notify watcher 即可；Drop 时回调结束、发送端释放，合并线程随之退出。
pub struct DocWatcher {
    _watcher: RecommendedWatcher,
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

pub fn start(app: AppHandle, path: &str) -> Result<DocWatcher, String> {
    let target = PathBuf::from(path);
    let dir = target
        .parent()
        .ok_or_else(|| "文件没有父目录".to_string())?
        .to_path_buf();
    let (tx, rx) = channel::<()>();

    // 合并线程：收到第一个事件后继续吸收 250ms 内的后续事件，静默后 stat 一次再广播。
    let app_for_worker = app.clone();
    let target_for_worker = target.clone();
    std::thread::spawn(move || loop {
        if rx.recv().is_err() {
            return;
        }
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let path_str = target_for_worker.to_string_lossy().to_string();
        let payload = match std::fs::metadata(&target_for_worker) {
            Ok(m) => FileChanged {
                path: path_str,
                exists: true,
                mtime: folio_fs::mtime_secs(&target_for_worker),
                size: m.len(),
            },
            Err(_) => FileChanged {
                path: path_str,
                exists: false,
                mtime: 0,
                size: 0,
            },
        };
        let _ = app_for_worker.emit("folio-file-changed", payload);
    });

    let target_for_filter = target.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| same_path(p, &target_for_filter)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(DocWatcher { _watcher: watcher })
}