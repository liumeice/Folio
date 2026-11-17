/* 公式与图表渲染回归（《Mermaid与MathJax渲染实现提示词.md》§5.4）：
 * 渲染层契约（md.ts）：行内 $…$ 命中/miss、块级 $$…$$ / ```math / ```mermaid、
 * 代码段优先、escapeHtml 往返、坐标不变量（$$ 吞掉的标题/任务仍记账）；
 * 排版层退化（mathjax.ts）：mock MathJax 成功/抛错/merror/库缺失四条路。
 * 运行：node --experimental-strip-types --test tests/formula.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mdToHtml, classifyCodeLang, escapeHtml } from "../src/lib/md.ts";
import { typesetMathIn } from "../src/lib/mathjax.ts";
import { isMermaidErrorSvg } from "../src/lib/mermaidRender.ts";

const dom = new JSDOM(`<!doctype html><body></body>`);

/** 挂进 body：排版模块的 el.isConnected 守卫只在「文档已切换」时中止——
 *  脱离文档的容器会全量跳过（这个副作用反倒在首轮测试里帮我们证明了守卫生效）。 */
function mount(mdSrc: string): HTMLElement {
  const el = dom.window.document.createElement("div");
  el.innerHTML = mdToHtml(mdSrc);
  dom.window.document.body.appendChild(el);
  return el;
}
const mathEls = (el: HTMLElement) => [...el.querySelectorAll("[data-math]")];
const codeOf = (el: Element) => el.getAttribute("data-code") ?? "";

/* ── 行内公式 ── */

test("行内 $…$ 与 $$…$$ 命中", () => {
  const h = mdToHtml("能量 $E=mc^2$ 与序列 $a_n$ 及块内联 $$x+y$$");
  const els = [...h.matchAll(/data-math="inline"[^>]*data-lang="tex" data-code="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(els, ["E=mc^2", "a_n", "x+y"], h);
  assert.ok(!h.includes("$E"), "原始 $ 定界符已被消费");
});

test("行内 miss：\\$、货币、首尾空白、跨行——全部保留字面量", () => {
  const t1 = mdToHtml("价格 \\$100 起");
  assert.ok(!t1.includes("data-math"), "转义 $ 不产公式：" + t1);
  const t2 = mdToHtml("$5 和 $10 都便宜");
  assert.ok(!t2.includes("data-math"), "货币 miss（体首尾空白）：" + t2);
  const t3 = mdToHtml("$ x $ 中间有边距");
  assert.ok(!t3.includes("data-math"), "首尾空白 miss：" + t3);
  const t4 = mdToHtml("$x\ny$ 跨行"); // 同段落两行：flushPara join("\\n") 后体含换行
  assert.ok(!t4.includes("data-math"), "跨行 miss（易错点 #1）：" + t4);
  const t5 = mdToHtml("未闭合 $x 就结束");
  assert.ok(!t5.includes("data-math"), "未闭合作字面量：" + t5);
});

test("行内 miss（真窗口回归）：货币段与转义 $ 不得跨句咬合成假公式", () => {
  // 形态即 CDP 探针实锤的那句：$5 … $10 的闭 $ 前是空白、\$ 转义对不参与配对
  const h = mdToHtml("行内：质能 $E=mc^2$。货币文本保持原样：$5 和 $10 不是公式。转义 \\$ 也不参与。");
  assert.equal((h.match(/data-math="inline"/g) ?? []).length, 1, "只许 $E=mc^2$ 一处命中：" + h);
  assert.ok(h.includes("$5 和 $10"), "货币字面量原样保留：" + h);
  assert.ok(h.includes("$ 也不参与"), "转义 \\$ 落为字面 $：" + h);
  const t2 = mdToHtml("价格$3和$5元");
  assert.ok(!t2.includes("data-math"), "闭 $ 后紧跟数字判 miss（GFM 规则）：" + t2);
});

test("代码段优先于公式", () => {
  const h = mdToHtml("用 `$x$` 表示价格区间");
  assert.ok(h.includes("<code>$x$</code>"), h);
  assert.ok(!h.includes("data-math"), "代码段内的 $ 不得开公式");
});

/* ── 块级公式 / 图表围栏 ── */

test("$$…$$ 成块：占位符存原文，块外文本正常", () => {
  const h = mdToHtml("前文\n\n$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$\n\n后文");
  assert.ok(h.includes('<div class="f-block" data-math="block" data-lang="tex" data-code="\\int_0^1 x\\,dx = \\tfrac{1}{2}">'), h);
  assert.ok(h.includes("<p>前文</p>") && h.includes("<p>后文</p>"), h);
  assert.ok(!h.includes("tfrac{1}{2}</p>"), "块内容不混进段落");
});

test("```math / ```mermaid 走围栏分流；```mathml 不受牵连", () => {
  const el = mount("```math\nE=mc^2\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```mathml\nx\n```");
  const m = el.querySelector('[data-math="block"][data-lang="math"]');
  assert.ok(m, "```math → 公式占位");
  assert.equal(codeOf(m!), "E=mc^2");
  const mm = el.querySelector("[data-mermaid]");
  assert.ok(mm, "```mermaid → 图表占位");
  assert.equal(codeOf(mm!), "graph TD\nA-->B", "属性转义往返无损（含 > 与换行）");
  assert.ok(el.innerHTML.includes('class="language-mathml"'), "mathml 仍是代码块（易错点 #12）");
  assert.equal(el.querySelectorAll("[data-mermaid]").length, 1);
});

test("escapeHtml 往返：data-code 含 & < > \\\" 经 DOM 解析逐字节还原", () => {
  const src = '$$\na & b < c > d "e" \\f\n$$';
  const el = mount(src);
  assert.equal(codeOf(el.querySelector("[data-math]")!), 'a & b < c > d "e" \\f');
  assert.ok(escapeHtml('a&b<c>"d').includes("&amp;") && escapeHtml('x"y').includes("&quot;"), "转义集完备");
});

test("zenuml 路由标记：首行 zenuml 关键字 → data-zuml（归 @zenuml/core），普通 mermaid 不受牵连", () => {
  const z = mdToHtml("```mermaid\nzenuml\n    title Reply message\n    Client->A: hi\n```");
  assert.ok(z.includes('data-mermaid="1"') && z.includes('data-zuml="1"') && z.includes('data-lang="zenuml"'), z);
  const m = mdToHtml("```mermaid\ngraph TD\nA-->B\n```");
  assert.ok(!m.includes("data-zuml") && m.includes('data-lang="mermaid"'), m);
});

test("classifyCodeLang 精确匹配", () => {
  assert.equal(classifyCodeLang("math"), "math");
  assert.equal(classifyCodeLang("MATH"), "math");
  assert.equal(classifyCodeLang("mermaid"), "mermaid");
  assert.equal(classifyCodeLang("Mermaid"), "mermaid");
  assert.equal(classifyCodeLang("mathml"), "code", "不能把 mathml 判成 math");
  assert.equal(classifyCodeLang("javascript"), "code");
  assert.equal(classifyCodeLang(""), "code");
});

/* ── 坐标不变量（CON-01/02 同类坑的公式版）：Rust 只认 ``` 围栏，$$ 内标题/任务仍计数 ── */

test("$$ 内的 \"# \" 行仍占 data-sec 序号（与 folio-core::headings 同坐标）", () => {
  const el = mount("# 一\n\n```\n# 假标题(围栏)\n```\n\n$$\n# 潜伏标题\n$$\n\n## 二");
  assert.ok(el.innerHTML.includes('data-sec="1"'), "「一」占 1");
  assert.ok(!el.innerHTML.includes('data-sec="2"'), "潜伏标题不产锚点元素");
  assert.ok(el.innerHTML.includes('data-sec="3"'), "「二」必须占 3（Rust 侧它是第 3 条标题）：" + el.innerHTML);
});

test("$$ 内的任务行仍占 [data-task] 序号（隐藏记账占位）", () => {
  const el = mount("- [ ] a\n\n$$\n- [ ] swallowed\n$$\n\n- [ ] b");
  const marks = [...el.querySelectorAll("[data-task]")];
  assert.equal(marks.length, 3, "a + 隐藏占位 + b：Rust toggle_task 同样数 3：" + el.innerHTML);
  assert.ok(marks[1].getAttribute("hidden") !== null, "中间那枚是隐藏占位，不可点");
});

/* ── 排版层：mock MathJax 的成败退化 ── */

type Stub = { startup: { promise: Promise<unknown> }; tex2svgPromise: (c: string, o: { display: boolean }) => Promise<HTMLElement> };
function stubMathJax(make: (code: string, display: boolean) => HTMLElement | Promise<HTMLElement>): Stub {
  const stub: Stub = {
    startup: { promise: Promise.resolve() },
    tex2svgPromise: async (code, o) => make(code, o.display),
  };
  (globalThis as Record<string, unknown>).MathJax = stub;
  return stub;
}
function svgContainer(svgInner = "OK") {
  const c = dom.window.document.createElement("mjx-container");
  const s = dom.window.document.createElement("svg");
  s.textContent = svgInner;
  c.appendChild(s);
  return c;
}

test("typesetMathIn：成功路 f-ready + svg；块/行内都排", async () => {
  stubMathJax((code) => svgContainer("svg:" + code));
  const el = mount("块前\n\n$$\nx^2\n$$\n\n内 $y_1$ 尾");
  await typesetMathIn(el);
  const targets = [...el.querySelectorAll("[data-math]")];
  assert.equal(targets.length, 2, "一块一行内");
  for (const t of targets) {
    assert.ok(t.classList.contains("f-ready"), "成功加 f-ready（解除 opacity 门）");
    assert.ok(t.innerHTML.includes("<svg"), t.innerHTML);
    assert.ok(!t.querySelector(".formula-fallback"), "成功块无退化 pre");
  }
});

test("typesetMathIn：抛错 → 原位「源码框 + 语法错误标注」；成功块不受牵连（需求方最终定夺）", async () => {
  stubMathJax((code) => {
    if (code.includes("bad")) throw new Error("TeX parse boom");
    return svgContainer();
  });
  const el = mount("$$\nbad syntax\n$$\n\n$$\ngood\n$$");
  await typesetMathIn(el);
  const els = [...el.querySelectorAll("[data-math]")];
  assert.ok(els[0].classList.contains("f-error"), "失败块标 f-error");
  const box = els[0].querySelector(".fb-box");
  assert.ok(box, "退化=原位源码框（.fb-box）");
  assert.ok(box!.querySelector(".fb-label")!.textContent!.includes("语法错误"), "框内标注语法错误");
  assert.ok(box!.querySelector("pre.formula-fallback")!.textContent!.includes("bad syntax"), "源码框内可见");
  assert.ok(els[1].classList.contains("f-ready"), "一篇里单块失败不中断其余（§5.3 验收 7）");
});

test("typesetMathIn：MathJax 渲染 merror 节点也判失败", async () => {
  stubMathJax(() => {
    const c = dom.window.document.createElement("mjx-container");
    const m = dom.window.document.createElement("mjx-merror");
    m.textContent = "Parse Error";
    c.appendChild(m);
    return c;
  });
  const el = mount("$$\n\\frac{1}{}\n$$");
  await typesetMathIn(el);
  const t = el.querySelector("[data-math]")!;
  assert.ok(t.classList.contains("f-error"), "merror 不回显成功态");
});

test("typesetMathIn：MathJax 缺失（如 asset: 不可用）→ 全部退化可见，绝不空白", async () => {
  (globalThis as Record<string, unknown>).MathJax = undefined;
  const el = mount("$$\n\\alpha\n$$\n\n与 $\\beta$ 同行");
  await typesetMathIn(el);
  const els = [...el.querySelectorAll("[data-math]")];
  assert.equal(els.length, 2);
  for (const t of els) {
    assert.ok(t.classList.contains("f-error"), "库缺失走退化分支（易错点 #7）");
    assert.ok(t.querySelector(".fb-box"), "源码框可见（绝不空白/白屏）");
  }
});

test("mermaid 错误回显图判定：只认可见错误文案，合法图内嵌 error-icon 样式不得误杀", () => {
  assert.ok(isMermaidErrorSvg('<svg><text class="error-text">Syntax error in text</text></svg>'));
  assert.ok(isMermaidErrorSvg('<svg><image class="error-icon"/><tspan>Syntax error in text</tspan></svg>'));
  // 误杀回归（20:3x 实测）：合法时序图 defs 里带 error-icon/error-text 样式与占位 defs——不是错误
  assert.ok(!isMermaidErrorSvg('<svg><style>.error-icon{fill:#552222}.error-text{fill:#552222}</style><defs><marker id="error-end-arrow"/></defs><text>前端</text></svg>'));
  assert.ok(!isMermaidErrorSvg('<svg><rect/><text>判定</text></svg>'), "正常图不误判");
});

test("typesetMathIn：空块退化；记账占位在成功/失败两路都存活", async () => {
  stubMathJax(() => svgContainer());
  const el = mount("$$\n$$\n\n- [ ] a\n\n$$\n- [ ] m\n$$");
  await typesetMathIn(el);
  assert.ok(el.querySelectorAll("[data-math]")[0].classList.contains("f-error"), "空块退化（§5.3 验收 4）");
  assert.equal(el.querySelectorAll("[data-task]").length, 2, "排版后 [data-task] 记账仍完整");
});
