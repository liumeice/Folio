/* MathJax v3 配置：必须**先于** tex-svg-full.js 执行（两个 defer 按文档序执行）。
 * 独立成文件而非 index.html 内联：CSP script-src 'self' 下免掉 nonce 依赖（Tauri 会给内联
 * script 注 nonce，但外部文件在 dev/打包/任何页面上都无条件可用，少一个环境差异）。 */
window.MathJax = {
  startup: {
    typeset: false, // 关键：禁自动整页 typeset——我们只排 [data-math] 占位，别碰正文其它处
  },
  tex: {
    // 分隔符照配置声明表；processEscapes 让 \$ 转义生效（与 md.ts 行内扫描同语义）
    inlineMath: [["$", "$"], ["\\(", "\\)"]],
    displayMath: [["$$", "$$"], ["\\[", "\\]"]],
    processEscapes: true,
  },
  svg: {
    fontCache: "none", // 内联字形：导出单文件 HTML 后公式不依赖外部缓存（约束 6）
  },
  options: {
    enableMenu: false, // 桌面阅读器里不弹 MathJax 右键菜单
  },
};
