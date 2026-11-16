/* 阅读视图代码块语法着色（性能 P0-2 改造后）：
 * · 本模块整体由 Reader 在首帧之后动态 import()——入口 bundle 不含 highlight.js；
 * · 语言按需注册：文档里真正出现的语言才拉取其语言包（每种语言独立小 chunk），
 *   未用到的语言一个字节都不下载。
 * 设计原则不变：只上色已注册的语言；未知/缺失语言保持素文本，不做猜测性 auto 高亮（纯本地、无 eval，CSP 安全）。 */
import hljs from "highlight.js/lib/core";

type LangFn = Parameters<typeof hljs.registerLanguage>[1];

/** 已支持语言 → 懒加载入口（新增语言在此挂一行即可，不进主包） */
const LOADERS: Record<string, () => Promise<{ default: LangFn }>> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  php: () => import("highlight.js/lib/languages/php"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  lua: () => import("highlight.js/lib/languages/lua"),
  bash: () => import("highlight.js/lib/languages/bash"),
  sql: () => import("highlight.js/lib/languages/sql"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  diff: () => import("highlight.js/lib/languages/diff"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

/** Markdown 围栏常见写法 → 已支持语言名（不做全量 alias 依赖，显式可控） */
const ALIAS: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  html: "xml", htm: "xml", xhtml: "xml", vue: "xml",
  py: "python", python3: "python",
  rs: "rust",
  golang: "go",
  "c++": "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  "c#": "csharp", cs: "csharp",
  rb: "ruby",
  kt: "kotlin",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", profile: "bash",
  ps1: "bash", powershell: "bash",
  mysql: "sql", psql: "sql", plsql: "sql",
  yml: "yaml",
  toml: "ini", conf: "ini", cfg: "ini", properties: "ini",
  docker: "dockerfile",
  mk: "makefile", mak: "makefile",
  patch: "diff", udiff: "diff",
  text: "plaintext", txt: "plaintext", plain: "plaintext",
};

/* 同一语言可能被多个代码块并发请求注册：inflight 去重，只 import 一次 */
const registering = new Map<string, Promise<boolean>>();
function ensureRegistered(lang: string): Promise<boolean> {
  if (hljs.getLanguage(lang)) return Promise.resolve(true);
  const inflight = registering.get(lang);
  if (inflight) return inflight;
  const loader = LOADERS[lang];
  if (!loader) return Promise.resolve(false);
  const p = loader()
    .then((m) => { hljs.registerLanguage(lang, m.default); return true; })
    .catch(() => false); // 语言包加载失败：该块保持素文本
  registering.set(lang, p);
  return p;
}

function langOf(el: HTMLElement): string | null {
  const m = el.className.match(/language-([\w#+.-]+)/);
  const raw = (m?.[1] || "").toLowerCase();
  if (!raw) return null;
  return ALIAS[raw] ?? raw;
}

export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const els = [...root.querySelectorAll<HTMLElement>("pre code")].filter((el) => el.dataset.hl !== "1");
  await Promise.all(els.map(async (el) => {
    const lang = langOf(el);
    if (!lang || !(await ensureRegistered(lang))) return; // 未知语言：保持素文本
    const code = el.textContent ?? "";
    try {
      el.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      el.dataset.hl = "1";
    } catch { /* 着色失败保持原文 */ }
  }));
}

export function registeredLanguages(): number {
  return hljs.listLanguages().length;
}
