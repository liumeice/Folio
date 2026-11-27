/* 编辑窗列表 Tab/Shift-Tab 的纯函数层（2026-11-27 编辑窗口优化）。
 *
 * 需求：有序列表选中项按 Tab 缩进后自动更新为子集序号（2. 下的首个子项显示 2.1.）。
 * 阅读区的层级编号由 md.ts 按列表容器现算；源码里的数字不会自动变，所以这里在
 * 缩进/反缩进后把同一列表块内的有序标记整体重排：
 *   - 每个“兄弟组”（同一父项 + 同一缩进 + 同一分隔符）从 1 或原有首号开始顺延；
 *   - 被移动的项如果成为该组第一项，则从 1 开始（Tab 进入父项下 → 2.1）；
 *   - 追加到已有子列表末尾时沿用该组首号，后续顺延（变成 2.3 等）。
 * 只改有序标记的数字，不动缩进、分隔符与正文；无列表的行原样返回。 */

export interface ListLineParts {
  indent: string;
  marker: string;
  ordered: boolean;
  num: number;
  /** "." 或 ")"；无序列表为空串 */
  delim: string;
  /** 标记与正文之间的空白 */
  gap: string;
  text: string;
}

/** 识别列表行（含任务项/空正文项）；不是列表返回 null */
export function splitListLine(line: string): ListLineParts | null {
  const m = line.match(/^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/);
  if (!m) return null;
  const marker = m[2];
  const ordered = /^\d/.test(marker);
  return {
    indent: m[1],
    marker,
    ordered,
    num: ordered ? parseInt(marker, 10) || 0 : 0,
    delim: ordered ? marker.slice(-1) : "",
    gap: m[3],
    text: m[4],
  };
}

/** 与 md.ts indentWidth 同一制表位口径（tab=4 对齐），供层级比较 */
export function indentWidth(ws: string): number {
  let col = 0;
  for (const c of ws) {
    if (c === " " ) col += 1;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** 对指定行加/减一级缩进；空行不动（避免制造纯空白行）。 */
export function indentBlockLines(lines: string[], touched: Set<number>, unit: string, outdent: boolean): string[] {
  return lines.map((line, i) => {
    if (!touched.has(i) || line.trim() === "") return line;
    if (!outdent) return unit + line;
    if (line.startsWith(unit)) return line.slice(unit.length);
    if (line.startsWith("\t")) return line.slice(1);
    let n = 0;
    while (n < 4 && line[n] === " ") n++;
    return line.slice(n);
  });
}

/** 列表行在 cmark 列模型里的标记列/内容列（见 md.ts 同一口径） */
function listCols(p: ListLineParts): { markerCol: number; contentCol: number } {
  const markerCol = indentWidth(p.indent);                 // 标记起始列
  const mEnd = markerCol + p.marker.length;                // 标记全 ASCII，字符数=列宽
  const gapCols = indentWidth(p.gap);
  const contentCol = p.text === "" || gapCols >= 5 ? mEnd + 1 : mEnd + gapCols;
  return { markerCol, contentCol };
}

/** 重排列表块内的有序标记。moved = 本次被 Tab/Shift-Tab 移动的行下标。 */
export function renumberOrderedBlock(lines: string[], moved: Set<number>): string[] {
  const parts = lines.map(splitListLine);
  const cols = parts.map((p) => (p ? listCols(p) : null));

  // 父项 = 向上最近的「标记列更小且内容列不超过本标记列」的列表行。
  // 这样 2. 下已经存在的 3 列缩进子项与刚 Tab 成 4 列的项仍归同一个父项，
  // 不会把新项误挂到上一个子项下面。空行可跨过，非列表行终止列表块。
  const parent = new Array<number>(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    const ci = cols[i];
    if (!ci) { parent[i] = -1; continue; }
    let p = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].trim() === "") continue;
      const cj = cols[j];
      if (!cj) break;
      if (cj.markerCol < ci.markerCol && cj.contentCol <= ci.markerCol) { p = j; break; }
    }
    parent[i] = p;
  }

  const groups = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const p = parts[i];
    if (!p || !p.ordered) continue;
    // 同一父项 + 同分隔符 = 同一个有序列表容器（缩进列可因 Tab/空格略有差异）
    const key = `${parent[i]}|${p.delim}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }

  const out = lines.slice();
  for (const ids of groups.values()) {
    const first = ids[0];
    const start = moved.has(first) ? 1 : parts[first]!.num;
    ids.forEach((idx, k) => {
      const p = parts[idx]!;
      out[idx] = p.indent + String(start + k) + p.delim + p.gap + p.text;
    });
  }
  return out;
}