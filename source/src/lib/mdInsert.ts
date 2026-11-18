/* Markdown 插入模板的纯函数层（方案 N-CTX-01 §3/§4）。
 * 所有函数只做字符串计算：输入源文本 + 选区/光标，输出一次连续替换 + 新选区，
 * 由编辑器侧一次性 dispatch（一次 Ctrl+Z 撤销整段）。不碰 DOM、不碰 CodeMirror。 */

export type ListKind = "ul" | "ol" | "task";
export type WrapKind = "bold" | "italic" | "code" | "strike" | "link";

/** 编辑窗右键菜单的命令（EditorBridge 执行，菜单只负责发命令） */
export type EditorCmd =
  | { kind: "table"; cols: number; rows: number }
  | { kind: "code"; lang: string }
  | { kind: "heading"; level: number }
  | { kind: "image" }
  | { kind: "link" }
  | { kind: "hr" }
  | { kind: "wrap"; style: WrapKind }
  | { kind: "list"; list: ListKind | "quote" }
  | { kind: "clip"; action: "cut" | "copy" | "paste" | "delete" | "selectAll" };

/** from/to=替换区间；selFrom/selTo=替换后的绝对选区 */
export interface EditOp {
  from: number;
  to: number;
  insert: string;
  selFrom: number;
  selTo: number;
}

interface LineSpan {
  start: number;
  end: number;
  text: string;
}

function lineAt(src: string, pos: number): LineSpan {
  const p = Math.max(0, Math.min(src.length, pos));
  // p=0 单独处理：lastIndexOf 会把负 fromIndex 夹成 0，反而把第 0 位的换行当成上一行行尾
  const start = p === 0 ? 0 : src.lastIndexOf("\n", p - 1) + 1;
  let end = src.indexOf("\n", p);
  if (end < 0) end = src.length;
  return { start, end, text: src.slice(start, end) };
}

/** 选区覆盖到的完整行范围（选区结束落在行首时不含该空行） */
function lineRange(src: string, from: number, to: number): { a: LineSpan; b: LineSpan } {
  const a = lineAt(src, from);
  let b = lineAt(src, to);
  if (to > from && b.start === to && b.end > b.start) b = lineAt(src, to - 1);
  return { a, b };
}

const leadingWs = (s: string) => (s.match(/^\s*/)?.[0] ?? "");

/** 块级模板：独占一行；非空行/行中位置自动补前后空行（文档首尾不补多余空行）。
 *  caretOffset / selFrom / selTo 相对 block 首字符。 */
export function insertBlock(
  src: string, from: number, to: number, block: string,
  caretOffset: number, selFrom?: number, selTo?: number,
): EditOp {
  const pos = Math.max(from, to);
  const line = lineAt(src, pos);
  const emptyLine = line.text.trim() === "";
  const changeFrom = emptyLine ? line.start : line.end;
  const changeTo = emptyLine ? line.end : line.end;
  // 非空行：先另起一行，再留一个空行（方案 §3.1「自动补前后空行」）
  const prefix = emptyLine ? "" : "\n\n";
  // 插入行之后是否还有正文：有则补一个空行把块与正文隔开
  const nextStart = line.end < src.length ? line.end + 1 : -1;
  let nextText = "";
  if (nextStart >= 0) {
    const nl = src.indexOf("\n", nextStart);
    nextText = src.slice(nextStart, nl < 0 ? src.length : nl);
  }
  const suffix = nextStart >= 0 && nextText.trim() !== "" ? "\n" : "";
  const insert = prefix + block + suffix;
  const base = changeFrom + prefix.length;
  const selA = selFrom != null ? base + selFrom : base + caretOffset;
  const selB = selTo != null ? base + selTo : selA;
  return { from: changeFrom, to: changeTo, insert, selFrom: selA, selTo: selB };
}

/** 表格：rows 含表头行；输出 M-1 行数据行。光标进第一格。 */
export function tableOp(src: string, from: number, to: number, cols: number, rows: number): EditOp {
  const c = Math.max(1, Math.min(8, Math.floor(cols)));
  const r = Math.max(2, Math.min(6, Math.floor(rows)));
  const head = "| " + Array.from({ length: c }, (_, i) => `列${i + 1}`).join(" | ") + " |";
  const sep = "| " + Array(c).fill("---").join(" | ") + " |";
  const data = "| " + Array(c).fill("").join(" | ") + " |";
  const text = [head, sep, ...Array(r - 1).fill(data)].join("\n");
  return insertBlock(src, from, to, text, 2);
}

export function codeBlockOp(src: string, from: number, to: number, lang: string): EditOp {
  const fence = "```" + (lang || "");
  if (from !== to) {
    const sel = src.slice(from, to);
    const insert = fence + "\n" + sel + "\n```";
    return { from, to, insert, selFrom: from + fence.length + 1, selTo: from + fence.length + 1 + sel.length };
  }
  return insertBlock(src, from, to, fence + "\n\n```", fence.length + 1);
}

export function imageOp(src: string, from: number, to: number): EditOp {
  return insertBlock(src, from, to, "![描述](images/文件名.png)", 2, 2, 4);
}

export function linkOp(src: string, from: number, to: number): EditOp {
  if (from !== to) return wrapOp(src, from, to, "link");
  return insertBlock(src, from, to, "[文本](url)", 1, 1, 3);
}

export function hrOp(src: string, from: number, to: number): EditOp {
  return insertBlock(src, from, to, "---", 3);
}

/** 行前缀：标题替换原有级别前缀；引用去掉已有 > 后重加。选区逐行处理。 */
export function prefixLinesOp(
  src: string, from: number, to: number, kind: "heading" | "quote", level = 1,
): EditOp {
  const { a, b } = lineRange(src, from, to);
  const lines = src.slice(a.start, b.end).split("\n");
  let firstPrefix = "";
  const out = lines.map((line, i) => {
    const indent = leadingWs(line);
    let rest = line.slice(indent.length);
    if (kind === "heading") {
      rest = rest.replace(/^#{1,6}[ \t]+/, "");
      firstPrefix = "#".repeat(level) + " ";
      return indent + firstPrefix + rest;
    }
    rest = rest.replace(/^>[ \t]?/, "");
    firstPrefix = "> ";
    return indent + firstPrefix + rest;
  });
  const insert = out.join("\n");
  const selFrom = a.start + leadingWs(lines[0]).length + firstPrefix.length;
  const selTo = from === to ? selFrom : a.start + insert.length;
  return { from: a.start, to: b.end, insert, selFrom, selTo };
}

export function wrapOp(src: string, from: number, to: number, style: WrapKind): EditOp {
  const sel = src.slice(from, to);
  if (style === "link") {
    const insert = `[${sel}](url)`;
    const caret = from + sel.length + 3;   // "](“ 之后
    return { from, to, insert, selFrom: caret, selTo: caret };
  }
  const [l, r] = style === "bold" ? ["**", "**"]
    : style === "italic" ? ["*", "*"]
    : style === "code" ? ["`", "`"]
    : ["~~", "~~"];
  const insert = l + sel + r;
  return { from, to, insert, selFrom: from + l.length, selTo: from + l.length + sel.length };
}

/* ── 列表 ─────────────────────────────────────── */

const LIST_RE = /^(\s*)(- \[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)(.*)$/;

function parseList(line: string): { indent: string; kind: ListKind; num: number; rest: string } | null {
  const m = line.match(LIST_RE);
  if (!m) return null;
  const token = m[2];
  const kind: ListKind = /^- \[/.test(token) ? "task" : /^\d/.test(token) ? "ol" : "ul";
  const num = kind === "ol" ? (parseInt(token, 10) || 1) : 0;
  return { indent: m[1], kind, num, rest: m[3] };
}

const marker = (kind: ListKind, n: number) =>
  kind === "ul" ? "- " : kind === "ol" ? `${n}. ` : "- [ ] ";

/** 当前行之前、最近的同缩进有序项编号（允许中间空行；遇到其它非空行即停） */
function prevOrdered(src: string, beforeStart: number, indent: string): number {
  const lines = src.slice(0, beforeStart).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const p = parseList(line);
    if (p && p.kind === "ol" && p.indent === indent) return p.num;
    return 0;
  }
  return 0;
}

/** 列表：单光标追加/转换一项；选区一次转换各行；每一击独立事务。 */
export function listOp(src: string, from: number, to: number, kind: ListKind): EditOp {
  if (from !== to) {
    const { a, b } = lineRange(src, from, to);
    const lines = src.slice(a.start, b.end).split("\n");
    const firstIndent = parseList(lines[0])?.indent ?? leadingWs(lines[0]);
    let n = prevOrdered(src, a.start, firstIndent);
    const out = lines.map((line) => {
      const p = parseList(line);
      const indent = p ? p.indent : leadingWs(line);
      const rest = p ? p.rest : line.slice(indent.length);
      if (kind === "ol") n += 1;
      return indent + marker(kind, kind === "ol" ? n : 0) + rest;
    });
    const insert = out.join("\n");
    const caret = a.start + insert.length;
    return { from: a.start, to: b.end, insert, selFrom: caret, selTo: caret };
  }

  const line = lineAt(src, from);
  const p = parseList(line.text);
  const indent = p ? p.indent : leadingWs(line.text);

  if (p && p.kind === kind) {
    // 同类项：在下方追加一项（有序续号、沿用缩进）
    const m = marker(kind, kind === "ol" ? p.num + 1 : 0);
    const insert = "\n" + indent + m;
    return { from: line.end, to: line.end, insert, selFrom: line.end + insert.length, selTo: line.end + insert.length };
  }

  const m = marker(kind, kind === "ol" ? prevOrdered(src, line.start, indent) + 1 : 0);
  if (p) {
    // 异类列表：原地换标记，保留内容
    const insert = indent + m + p.rest;
    return { from: line.start, to: line.end, insert, selFrom: line.start + indent.length + m.length, selTo: line.start + indent.length + m.length };
  }
  if (line.text.trim() === "") {
    const insert = indent + m;
    return { from: line.start, to: line.end, insert, selFrom: line.start + insert.length, selTo: line.start + insert.length };
  }
  // 普通行：转成列表项，光标停在标记之后
  const insert = indent + m + line.text.slice(indent.length);
  return { from: line.start, to: line.end, insert, selFrom: line.start + indent.length + m.length, selTo: line.start + indent.length + m.length };
}