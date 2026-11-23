/* SVG symbol 定义（自原型移植，零依赖） */
export default function Icons() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><defs>
      <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
      <symbol id="i-max" viewBox="0 0 24 24"><path d="M6.5 6.5h11v11h-11z"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
      <symbol id="i-chev-d" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></symbol>
      <symbol id="i-chev-u" viewBox="0 0 24 24"><path d="M18 14.5l-6-6-6 6"/></symbol>
      {/* 原型符号清单 §2.5 有左右向 chevron，正式版此前漏移植；子菜单父项（i-chev-r）依赖 */}
      <symbol id="i-chev-l" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></symbol>
      <symbol id="i-chev-r" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.2-4.2"/></symbol>
      <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 6.5a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/></symbol>
      <symbol id="i-folder-open" viewBox="0 0 24 24"><path d="M3.5 18.5V6.5a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2V11 M3.5 18.5l2.6-6.5h15.2l-2.6 6.5z"/></symbol>
      <symbol id="i-file-text" viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9 12.5h6M9 16.5h4"/></symbol>
      <symbol id="i-md" viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 15V9.5l2.2 2.4L11.5 9.5V15"/><path d="M15.5 9.5V14"/><path d="M14 12.6l1.5 1.6 1.5-1.6"/></symbol>
      {/* 自原型补移植（2026-11-16）：rail 打开文件快捷钮 + 复制成功浮层 */}
      {/* 官方工具图标集（2026-11-16 需求方提供，rail 与对应菜单项共用；打开文件/打开文件夹/最近/大纲四枚于 2026-11-17 按 prototype/icon/index.html 线条图标集 v-S6 更换） */}
      <symbol id="i-new-file" viewBox="0 0 24 24"><path d="M12.8 3.8v4h4"/><path d="M7.6 3.8h5.2l4 4v5.2"/><path d="M7.6 3.8a2.5 2.5 0 0 0-2.5 2.5v10a2.5 2.5 0 0 0 2.5 2.5h4.3"/><path d="M17.5 15.1v5.2M14.9 17.7h5.2"/></symbol>
      <symbol id="i-open-file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M8.5 16.5 14 11"/><path d="M10.5 11H14v3.5"/></symbol>
      <symbol id="i-open-folder" viewBox="0 0 24 24"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.96 2.5L19.5 18a2 2 0 0 1-1.96 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></symbol>
      <symbol id="i-recent" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5 9.75 9.75 0 0 0-6.37 2.6L3.5 8"/><path d="M3.5 4.5v4h4"/><path d="M12 8v4l3.5 2"/></symbol>
      <symbol id="i-outline" viewBox="0 0 24 24"><path d="M5 6h.01"/><path d="M9 6h11"/><path d="M9 12h.01"/><path d="M13 12h7"/><path d="M9 18h.01"/><path d="M13 18h7"/></symbol>
      <symbol id="i-file" viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/></symbol>
      {/* 另存为（2026-11-18）：软盘轮廓 + 出离箭头，线条制式同工具图标集 */}
      <symbol id="i-save-as" viewBox="0 0 24 24"><path d="M6.5 3.5h8l4 4v8"/><path d="M6.5 3.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h4.2"/><path d="M8.5 3.5v4h5"/><path d="M13.5 16.5h7"/><path d="M17.5 13.5l3 3-3 3"/></symbol>
      {/* 源码自动格式化（2026-11-18）：文本行 + 整理星芒，线条制式同工具图标集 */}
      <symbol id="i-format" viewBox="0 0 24 24"><path d="M4.5 6.5h15M4.5 11.5h9M4.5 16.5h5.5"/><path d="M17 12.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/></symbol>
      {/* 大纲全部展开 / 收起（2026-11-18）：单箭头 + 限位线，两枚包围盒同为 y=8–16，
          保证并排时视觉高度一致（需求方对照原型确认） */}
      <symbol id="i-ol-expand" viewBox="0 0 24 24"><path d="M7 8l5 5 5-5"/><path d="M7 16h10"/></symbol>
      <symbol id="i-ol-collapse" viewBox="0 0 24 24"><path d="M7 16l5-5 5 5"/><path d="M7 8h10"/></symbol>
      {/* 编辑窗右键菜单图标（2026-11-19 需求方定夺）：功能图标一律用 ui-iconset-18 图标集
          （prototype/icons/output/ui-iconset-18）；每枚的 <g transform>+stroke-width 是图标集的
          「18.4/24 光学框」补偿参数，勿手改；.ico 的 stroke:currentColor 与 linecap/linejoin 照常继承。
          图标集未覆盖的两枚新增项例外：标注块 ix-callout（原型线性侧栏标记）、Emoji 项用 🙂 字形。 */}
      <symbol id="i-scissors" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.000 -12.400)" stroke-width="1.6287"><circle cx="7.6" cy="17.9" r="2.5"/><circle cx="16.4" cy="17.9" r="2.5"/><path d="M9.26 16.03 19.6 4.4"/><path d="M14.74 16.03 4.4 4.4"/></g></symbol>
      <symbol id="i-paste" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></g></symbol>
      <symbol id="i-select-all" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.000 -12.000)" stroke-width="1.6287"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.2 12.1 11 14.9 16 9.7"/></g></symbol>
      <symbol id="i-bold" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.500 -12.000)" stroke-width="1.6287"><path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/></g></symbol>
      <symbol id="i-italic" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.000 -12.000)" stroke-width="1.6287"><line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/></g></symbol>
      <symbol id="i-strikethrough" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.000 -12.000)" stroke-width="1.6287"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/></g></symbol>
      <symbol id="i-link" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83920) translate(-12.000 -12.000)" stroke-width="2.0257"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></g></symbol>
      <symbol id="i-list-bullet" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.92778) translate(-12.000 -12.000)" stroke-width="1.8323"><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></g></symbol>
      <symbol id="i-list-number" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.84450) translate(-12.000 -12.738)" stroke-width="2.0130"><g stroke-width="1.7"><path d="M4 3.60 5 2.85V7.25"/><path d="M3.9 7.25h2.2"/><path d="M6.5 14.55H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/><path d="M3.5 17.90a1.55 1.55 0 0 1 3 .4c0 1-.85 1.45-1.6 1.45.75 0 1.6.45 1.6 1.45a1.55 1.55 0 0 1-3 .4"/></g><path d="M10.4 5h10.2"/><path d="M10.4 12h10.2"/><path d="M10.4 19h10.2"/></g></symbol>
      <symbol id="i-task-list" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.90761) translate(-11.800 -12.000)" stroke-width="1.8731"><rect x="3" y="2.8" width="4.8" height="4.8" rx="1.3"/><rect x="3" y="9.6" width="4.8" height="4.8" rx="1.3"/><rect x="3" y="16.4" width="4.8" height="4.8" rx="1.3"/><path d="M10.6 5.2h10"/><path d="M10.6 12h10"/><path d="M10.6 18.8h10"/></g></symbol>
      <symbol id="i-quote" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.92778) translate(-12.000 -12.000)" stroke-width="1.8323"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></g></symbol>
      <symbol id="i-table" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.92778) translate(-12.000 -12.000)" stroke-width="1.8323"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/><path d="M15 9v12"/></g></symbol>
      <symbol id="i-image" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.92778) translate(-12.000 -12.000)" stroke-width="1.8323"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="16.4" cy="8.2" r="1.5"/><path d="M3.6 18.4 8.1 13.3l3.5 3.5 2.6-2.8 5.9 5.8"/></g></symbol>
      <symbol id="i-divider" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.19286) translate(-12.000 -12.000)" stroke-width="1.4251"><path d="M5 12h14"/></g></symbol>
      <symbol id="ix-callout" viewBox="0 0 16 16"><g stroke-width="1.4"><path d="M2.7 3.3v9.4"/><path d="M5.9 4.4h7.4M5.9 8h7.4M5.9 11.6h4.6"/></g></symbol>
      <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/></symbol>
      <symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.6 6.5h.01M4.6 12h.01M4.6 17.5h.01"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.6l4.4 4.4L19 7.5"/></symbol>
      <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/></symbol>
      <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15.5V4.5M8 9l4-4 4 4"/><path d="M4.5 19.5h15"/></symbol>
      <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.8 12S6.4 6.2 12 6.2 21.2 12 21.2 12 17.6 17.8 12 17.8 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.9"/></symbol>
      <symbol id="i-type" viewBox="0 0 24 24"><path d="M5 6.5h14M12 6.5V19M9 19h6"/></symbol>
      {/* 撤销 / 重做（方案 v1.0，2026-11-23）：24 视窗线性描边，与现有图标同族 */}
      <symbol id="i-undo" viewBox="0 0 24 24"><path d="M9 14.5 4.5 10 9 5.5"/><path d="M4.8 10h9.7a5 5 0 0 1 0 10h-3.6"/></symbol>
      <symbol id="i-redo" viewBox="0 0 24 24"><path d="M15 14.5 19.5 10 15 5.5"/><path d="M19.2 10H9.5a5 5 0 0 0 0 10h3.6"/></symbol>
      <symbol id="i-panel-l" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9 5v14"/></symbol>
      {/* 自原型移植：设置左导航（外观/代码与表格） */}
      <symbol id="i-code" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></g></symbol>
      <symbol id="i-contrast" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z"/></symbol>
      <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 8h9M17.5 8H20M4 16h3.5M12 16h8"/><circle cx="15.2" cy="8" r="2.2"/><circle cx="9.6" cy="16" r="2.2"/></symbol>
      <symbol id="i-save" viewBox="0 0 24 24"><path d="M5.5 5.5h10l3 3v10h-13z"/><path d="M8.5 5.5v4.5h6.5V5.5M8.5 15.5h7"/></symbol>
      <symbol id="i-copy" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v5M12 8h.01"/></symbol>
      {/* 目录树「重命名」（2026-11-20）：线性铅笔，与 ui-iconset-18 同族收口 */}
      <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4.4 19.6l.8-3.9L16.2 5.5a1.7 1.7 0 0 1 2.4 0l.4.4a1.7 1.7 0 0 1 0 2.4L8.3 18.8l-3.9.8Z"/><path d="M14.6 7.2l2.7 2.7"/></symbol>
      <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4.8h5.2v5.2M19.2 4.8L11 13"/><path d="M18.4 14v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.2a1.6 1.6 0 0 1 1.6-1.6H10"/></symbol>
      <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19.2V4.8M6 10.8l6-6 6 6"/></symbol>
      <symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 4.8v14.4M6 13.2l6 6 6-6"/></symbol>
      <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19.2 12H4.8M10.8 6l-6 6 6 6"/></symbol>
      <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M4.8 12h14.4M13.2 6l6 6-6 6"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></symbol>
      <symbol id="i-heading" viewBox="0 0 24 24"><g transform="translate(12 12) scale(1.04375) translate(-12.000 -12.000)" stroke-width="1.6287"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/></g></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3.2 2"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3.7 12a8.4 8.4 0 1 0 2.7-6.2L3.5 8.3"/><path d="M3.3 4.4v4h4"/><path d="M12 7.7V12l3.1 1.9"/></symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8"/><path d="M20.6 4.2v4.4h-4.4"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></g></symbol>
      <symbol id="i-co-note" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2M12 7.8h.01"/></symbol>
      <symbol id="i-co-tip" viewBox="0 0 24 24"><path d="M12 20s-7-4.3-8.7-8.6C2 8.2 4 5.2 7 5c1.9-.1 3.7 1 4.2 2.2h1.6C13.3 6 15.1 4.9 17 5c3 .2 5 3.2 3.7 6.4C19 15.7 12 20 12 20z"/></symbol>
      <symbol id="i-co-important" viewBox="0 0 24 24"><path d="M13.2 2.8 5 13.6h5.4l-.6 7.6L19 10.4h-5.4z"/></symbol>
      <symbol id="i-co-warning" viewBox="0 0 24 24"><path d="M12 4.2 3.2 19.2h17.6z"/><path d="M12 10v4.2M12 17.2h.01"/></symbol>
      <symbol id="i-co-caution" viewBox="0 0 24 24"><path d="M8.6 3.4h6.8L20.6 8.6v6.8L15.4 20.6H8.6L3.4 15.4V8.6z"/><path d="M12 8v5.4M12 16.4h.01"/></symbol>
      {/* 右键「标注块」子面板的彩色标签图标（2026-11-19 原型口径）：
          <g transform>+stroke-width 是图标集的「18.4/24 光学框」补偿参数，勿手改；阅读区 callout 仍用 i-co-* */}
      <symbol id="s-note" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></g></symbol>
      <symbol id="s-tip" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></g></symbol>
      <symbol id="s-important" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.500)" stroke-width="2.0359"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 15h.01"/><path d="M12 7v4"/></g></symbol>
      <symbol id="s-warning" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83396) translate(-11.988 -11.988)" stroke-width="2.0385"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></g></symbol>
      <symbol id="s-caution" viewBox="0 0 24 24"><g transform="translate(12 12) scale(0.83500) translate(-12.000 -12.000)" stroke-width="2.0359"><path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/></g></symbol>
    </defs></svg>
  );
}
