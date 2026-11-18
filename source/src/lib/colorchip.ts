/* 阅读窗色值前置色块（方案 D，UI 规范 §4.5）：
 * 正文/表格/行内代码里的十六进制与 rgb()/rgba()/hsl()/hsla() 色值前加一枚 8px 方色点，
 * 文字颜色一律不动——避免「色值贴近底色→文字不可读」的死穴。
 * 设计取舍（需求方 2026-11-18 样例确认）：
 * - 色点带 1px --line-hi 细边：近底色值（如深色主题的 #080D18）仍可辨识；
 * - 半透明色点由浏览器在局部底色上真实合成，所见即所得；
 * - 色值文字保持单一文本节点（包在 span 内），全文搜索按整 token 命中不受影响；
 * - 围栏代码块交给语法着色体系、链接文字保持强调色语义，均不上色块；
 * - 导出 HTML/PDF 与阅读窗同源 DOM，自动跟随。 */

/* 主扫描：hex 带词尾界（拒绝 #12345 / #1234567），函数记法允许内部空格；
 * 词首界在代码里判（避免 div#123、issue#abc 这类标识符误伤）。 */
const MASTER = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?)\([^()]*\)/g;

/** 校验并原样返回可作 CSS 颜色的 token；非法（位数不对/参数越界/记法错）返回 null */
export function colorToken(tok: string): string | null {
  if (tok[0] === "#") {
    const s = tok.slice(1);
    return s.length === 3 || s.length === 4 || s.length === 6 || s.length === 8 ? tok : null;
  }
  const m = tok.match(/^(rgba?|hsla?)\(([^()]*)\)$/i);
  if (!m) return null;
  const parts = m[2].split(/[,/]/).map((x) => x.trim()).filter((x) => x !== "");
  if (parts.length < 3 || parts.length > 4) return null;
  if (!parts.every((x) => /^\.?\d+(\.\d+)?%?$/.test(x))) return null;
  const val = (x: string, scale: number) =>
    x.endsWith("%") ? (parseFloat(x) / 100) * scale : parseFloat(x);
  if (/^rgb/i.test(m[1])) {
    const v = parts.slice(0, 3).map((x) => val(x, 255));
    if (v.some((x) => !isFinite(x) || x < 0 || x > 255)) return null;
  } else {
    const s = val(parts[1], 100), l = val(parts[2], 100);
    if (!isFinite(s) || !isFinite(l) || s < 0 || s > 100 || l < 0 || l > 100) return null;
    if (!isFinite(parseFloat(parts[0]))) return null;
  }
  if (parts.length === 4) {
    const a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if (!isFinite(a) || a < 0 || a > 1) return null;
  }
  return tok;
}

/** root 内所有文本节点上色块（幂等：已在 .cchip 内的节点跳过） */
export function applyColorChips(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n as Text;
      const p = t.parentElement;
      if (!p || p.closest("a,pre,button,svg,mjx-container,.cchip")) return NodeFilter.FILTER_REJECT;
      return t.data.indexOf("#") >= 0 || /rgba?\s*\(|hsla?\s*\(/i.test(t.data)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const t of nodes) {
    const data = t.data;
    MASTER.lastIndex = 0;
    let m: RegExpExecArray | null, last = 0;
    let frag: DocumentFragment | null = null;
    while ((m = MASTER.exec(data))) {
      const prev = m.index > 0 ? data[m.index - 1] : "";
      if (/[0-9A-Za-z_-]/.test(prev)) continue;          // div#123 / xrgba(...) 类标识符不碰
      const col = colorToken(m[0]);
      if (!col) continue;
      frag ??= document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(data.slice(last, m.index)));
      const chip = document.createElement("span");
      chip.className = "cchip";
      const dot = document.createElement("i");
      dot.setAttribute("style", "background:" + col);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(m[0]));    // token 保持单一文本节点（搜索命中用）
      frag.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (!frag) continue;
    if (last < data.length) frag.appendChild(document.createTextNode(data.slice(last)));
    t.replaceWith(frag);
  }
}
