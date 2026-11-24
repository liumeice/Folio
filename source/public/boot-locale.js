/* 启动骨架首帧语言（多语言设计 §3.6）：在 main.tsx 之前执行，只读 localStorage 镜像。
 * 失败时不阻塞启动——静态中文骨架与 boot.ts 的 5 秒兜底仍然生效。 */
(function () {
  try {
    var pref = localStorage.getItem("folio:localePref") || "auto";
    var langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : (navigator.language ? [navigator.language] : []);
    var list = [];
    for (var i = 0; i < langs.length; i++) list.push(String(langs[i]).toLowerCase());

    function resolve(p) {
      if (p === "zh-CN" || p === "en-US") return p;
      var j;
      for (j = 0; j < list.length; j++) {
        if (list[j] === "zh-cn") return "zh-CN";
        if (list[j] === "en-us") return "en-US";
      }
      for (j = 0; j < list.length; j++) {
        if (list[j].indexOf("zh") === 0) return "zh-CN";
        if (list[j].indexOf("en") === 0) return "en-US";
      }
      return list.length ? "en-US" : "zh-CN";
    }

    var locale = resolve(pref);
    document.documentElement.lang = locale;
    var hint = document.getElementById("bs-hint");
    if (hint) hint.textContent = locale === "zh-CN" ? "正在打开文档…" : "Opening document…";
    localStorage.setItem("folio:localeResolved", locale);
  } catch (e) { /* 隐私模式 / 旧环境：保持静态中文骨架 */ }
})();