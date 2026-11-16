/* 启动骨架移除（性能 P0-1）。
 * 骨架本体在 index.html 内联 HTML/CSS——窗口出现即有画面，不依赖 JS bundle 体积；
 * 这里只负责"揭幕"：store 启动链路拿到内容（openDoc 完成 / 无文档 / 失败）时调用，
 * main.tsx 另有 5s 兜底，任何启动异常都不会让骨架卡死。CSP 禁内联 script，故必须由模块代码移除。 */
export function dismissSplash(): void {
  const el = document.getElementById("boot-splash");
  if (!el) return;
  el.classList.add("gone");
  window.setTimeout(() => el.remove(), 500); // 等淡出过渡走完再摘除节点
}
