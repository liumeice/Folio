#!/usr/bin/env node
/* 打包发号器（2026-11-16）：任何入口的 `tauri build`（release.sh / 直接 npx / 任意 agent 实例）
 * 都经 tauri 的 beforeBuildCommand 走到这里，每次构建发放一个新「编译次数」，杜绝
 * 「绕过 release.sh 就回到 0 / 两个实例撞号」。
 *   .build          = 最近一次已发放的第四段号（唯一持久游标）
 *   .build-version  = 本次发放的完整四段版本（vite / build.rs / release.sh 共读）
 *   .build.lock     = 目录锁（NTFS 原子 mkdir），跨进程互斥；>10min 视为死锁夺还
 * 基线（主.次.修复）始终取 tauri.conf.json 的 version。 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const P = (n) => path.join(ROOT, n);
const BASE = JSON.parse(fs.readFileSync(P("src-tauri/tauri.conf.json"), "utf8")).version;
// 历史锚点：需求方确认上一发布版为 0.2.0.4（2026-11-16）；游标落后于锚点时按锚点续发
const ANCHOR = 4;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = P(".build.lock");
let held = false;
for (let i = 0; i < 75 && !held; i++) {          // 最长 ~15s
  try { fs.mkdirSync(lock); held = true; }
  catch {
    try {
      if (i > 30 && Date.now() - fs.statSync(lock).mtimeMs > 6e5) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
    } catch { /* ignore */ }
    sleep(200);
  }
}
if (!held) { console.error("[bump] 取 .build.lock 超时——另一实例正在发号，稍后重试"); process.exit(1); }
try {
  const prev = Math.max(parseInt(fs.readFileSync(P(".build"), "utf8"), 10) || 0, ANCHOR);
  const n = prev + 1;
  const ver = `${BASE}.${n}`;
  fs.writeFileSync(P(".build"), String(n) + "\n");
  fs.writeFileSync(P(".build-version"), ver + "\n");
  console.log(`[bump] Folio v${ver}（基线 ${BASE} + 编译次数 ${n}；上一号 ${prev}）`);
} finally {
  fs.rmSync(lock, { recursive: true, force: true });
}
