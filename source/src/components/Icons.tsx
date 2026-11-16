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
      {/* 官方工具图标集（2026-11-16，prototype/toolbar-icons.html；rail 与对应菜单项共用） */}
      <symbol id="i-new-file" viewBox="0 0 24 24"><path d="M12.8 3.8v4h4"/><path d="M7.6 3.8h5.2l4 4v5.2"/><path d="M7.6 3.8a2.5 2.5 0 0 0-2.5 2.5v10a2.5 2.5 0 0 0 2.5 2.5h4.3"/><path d="M17.5 15.1v5.2M14.9 17.7h5.2"/></symbol>
      <symbol id="i-open-file" viewBox="0 0 24 24"><path d="M12.8 3.8v4h4"/><path d="M7.6 3.8h5.2l4 4v5.2"/><path d="M7.6 3.8a2.5 2.5 0 0 0-2.5 2.5v10a2.5 2.5 0 0 0 2.5 2.5h4.3"/><path d="M15.2 19.2c1.3-1.3 2.7-2.7 4.1-4.2"/><path d="M16.1 14.1h4.1v4.1"/></symbol>
      <symbol id="i-open-folder" viewBox="0 0 24 24"><path d="M3.7 18.5V6.7a2 2 0 0 1 2-2h3.5l2.2 2.4h6.9a2 2 0 0 1 2 2v2.6"/><path d="M3.9 18.5 6.5 12h14.1l-2.6 6.5z"/></symbol>
      <symbol id="i-recent" viewBox="0 0 24 24"><path d="M20.6 12a8.6 8.6 0 1 1-2.5-6.1"/><path d="M20.8 4.3v4.2h-4.2"/><path d="M12 7.8V12l3 1.9"/></symbol>
      <symbol id="i-outline" viewBox="0 0 24 24"><path d="M4.6 6.5h.01M8.4 6.5h10.7M6.9 12h.01M10.7 12h8.1M9.2 17.5h.01M13 17.5h5.8"/></symbol>
      <symbol id="i-file" viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/></symbol>
      <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/></symbol>
      <symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.6 6.5h.01M4.6 12h.01M4.6 17.5h.01"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.6l4.4 4.4L19 7.5"/></symbol>
      <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/></symbol>
      <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15.5V4.5M8 9l4-4 4 4"/><path d="M4.5 19.5h15"/></symbol>
      <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.8 12S6.4 6.2 12 6.2 21.2 12 21.2 12 17.6 17.8 12 17.8 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.9"/></symbol>
      <symbol id="i-type" viewBox="0 0 24 24"><path d="M5 6.5h14M12 6.5V19M9 19h6"/></symbol>
      <symbol id="i-panel-l" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9 5v14"/></symbol>
      {/* 自原型移植：设置左导航（外观/代码与表格） */}
      <symbol id="i-code" viewBox="0 0 24 24"><path d="M8.6 8L5 12l3.6 4M15.4 8L19 12l-3.6 4"/></symbol>
      <symbol id="i-contrast" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z"/></symbol>
      <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 8h9M17.5 8H20M4 16h3.5M12 16h8"/><circle cx="15.2" cy="8" r="2.2"/><circle cx="9.6" cy="16" r="2.2"/></symbol>
      <symbol id="i-save" viewBox="0 0 24 24"><path d="M5.5 5.5h10l3 3v10h-13z"/><path d="M8.5 5.5v4.5h6.5V5.5M8.5 15.5h7"/></symbol>
      <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15.5h-.8a1.2 1.2 0 0 1-1.2-1.2V5.5a1.2 1.2 0 0 1 1.2-1.2h8.8A1.2 1.2 0 0 1 14.7 5.5v.8"/></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v5M12 8h.01"/></symbol>
      <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4.8h5.2v5.2M19.2 4.8L11 13"/><path d="M18.4 14v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.2a1.6 1.6 0 0 1 1.6-1.6H10"/></symbol>
      <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19.2V4.8M6 10.8l6-6 6 6"/></symbol>
      <symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 4.8v14.4M6 13.2l6 6 6-6"/></symbol>
      <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19.2 12H4.8M10.8 6l-6 6 6 6"/></symbol>
      <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M4.8 12h14.4M13.2 6l6 6-6 6"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></symbol>
      <symbol id="i-heading" viewBox="0 0 24 24"><path d="M5.5 5.5v13M13.5 5.5v13M5.5 12h8M17.5 9.5h3v9"/></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3.2 2"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3.7 12a8.4 8.4 0 1 0 2.7-6.2L3.5 8.3"/><path d="M3.3 4.4v4h4"/><path d="M12 7.7V12l3.1 1.9"/></symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8"/><path d="M20.6 4.2v4.4h-4.4"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></symbol>
      <symbol id="i-co-note" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2M12 7.8h.01"/></symbol>
      <symbol id="i-co-tip" viewBox="0 0 24 24"><path d="M12 20s-7-4.3-8.7-8.6C2 8.2 4 5.2 7 5c1.9-.1 3.7 1 4.2 2.2h1.6C13.3 6 15.1 4.9 17 5c3 .2 5 3.2 3.7 6.4C19 15.7 12 20 12 20z"/></symbol>
      <symbol id="i-co-important" viewBox="0 0 24 24"><path d="M13.2 2.8 5 13.6h5.4l-.6 7.6L19 10.4h-5.4z"/></symbol>
      <symbol id="i-co-warning" viewBox="0 0 24 24"><path d="M12 4.2 3.2 19.2h17.6z"/><path d="M12 10v4.2M12 17.2h.01"/></symbol>
      <symbol id="i-co-caution" viewBox="0 0 24 24"><path d="M8.6 3.4h6.8L20.6 8.6v6.8L15.4 20.6H8.6L3.4 15.4V8.6z"/><path d="M12 8v5.4M12 16.4h.01"/></symbol>
    </defs></svg>
  );
}
