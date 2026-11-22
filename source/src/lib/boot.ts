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

/** 本次文档加载的导航类型（Navigation Timing）；拿不到（旧内核/mock）→ undefined，按冷启动处理 */
export function bootNavType(): string | undefined {
  try {
    return (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  } catch {
    return undefined;
  }
}

/** 本次启动要不要自动恢复文档（bug 2026-11-22：WebView 刷新=整页重载被当冷启动，
 *  「恢复上次文档=关」的用户直接落空态，当前文档"消失"）。
 *  口径：冷启动尊重开关（关=空态快启）；会话内重启（navType=reload，含刷新通道与
 *  WebView 渲染进程崩溃自动重载）无视开关恢复历史首位——那是用户正在读的那篇。 */
export function shouldRestoreOnBoot(restoreOnLaunch: boolean | undefined, navType: string | undefined): boolean {
  return restoreOnLaunch !== false || navType === "reload";
}
