/* 编辑区着色的机械核对（不依赖窗口）。三条各管一类回归：
 *   A 覆盖度：样本文档语法树里出现的 tag，必须被着色表接住，或落在"默认样式本来就不碰"的豁免集里
 *   B 层叠：着色表用到的类名必须在 app.css 里有定义，且 .cmx-plain 必须排在具体类之前
 *   C 装饰：结构装饰依赖的节点确实存在于语法树（围栏/引用/列表符号/任务标记/表头）
 * 配色表逐条对齐原型：prototype/prototype.html:394-408。
 * 运行：node --experimental-strip-types --test tests/unit/mdstyle.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { md } from "../../src/lib/mdEditor.ts";
import { ensureSyntaxTree } from "@codemirror/language";
import { getStyleTags, tags as t, type Tag } from "@lezer/highlight";
import { MD_SPEC, MD_CLASS } from "../../src/lib/mdstyle.ts";

const SAMPLE = [
  "# H1",
  "",
  "正文 **粗** *斜* ~~删~~ `内码` [文](http://a.b) <http://c.d> 转义 \* 实体 &amp;",
  "",
  "- 无序项",
  "- [ ] 待办",
  "- [x] 完成",
  "1. 有序项",
  "",
  "> 引用 **粗** 与 `码`",
  "",
  "| 甲 | 乙 |",
  "| --- | --- |",
  "| 1 | `2` |",
  "",
  "---",
  "",
  "```js",
  "const x = 1; // 注释",
  "```",
  "",
  "    缩进代码块",
].join("\n");

/** 豁免集：defaultHighlightStyle 里没有这两条 tag 的规则（核对过 @codemirror/language 的
 *  defaultHighlightStyle 定义：comment/meta/link/heading/emphasis/strong/strikethrough/keyword/
 *  atom+bool+url+contentSeparator+labelName/literal/inserted/string/deleted/regexp/escape/…），
 *  所以不写进着色表也不会被补色。曾经把 list/content 也"中性化"过，结果同一 span 上的
 *  行内代码配色被盖掉——实机核对抓到后取消。 */
const EXEMPT = new Set<Tag>([t.list, t.content]);

/** 全树唯一来源：ensureSyntaxTree 完成态直接返回的 Tree。
 *  不再经 syntaxTree(state) 快照 API——它挑 slot 的时机在并行负载下不确定，
 *  2026-11-17 实测即便预解析过仍偶发拿回缺尾部构造的半树（FencedCode 失踪案）。 */
function parsed(): NonNullable<ReturnType<typeof ensureSyntaxTree>> {
  const tr = ensureSyntaxTree(state, state.doc.length, 2000);
  assert.ok(tr, "样本文档未被完整解析（ensureSyntaxTree 超时）");
  return tr;
}

function treeTags(): Set<Tag> {
  const out = new Set<Tag>();
  parsed().iterate({
    enter: (node) => {
      const st = getStyleTags(node);
      if (st) for (const tg of st.tags) out.add(tg);
    },
  });
  return out;
}

function treeNodes(): Set<string> {
  const out = new Set<string>();
  parsed().iterate({ enter: (n) => { out.add(n.name); } });
  return out;
}

// 用编辑区的同一个入口造状态：配置一改，这里的断言立刻跟着变（防"测试与 app 两套解析器"漂移）。
// syntaxTree() 拿的是「当前快照」——CodeMirror 增量异步解析，多文件并行跑时可能尚未推到文末
// （2026-11-17 实测：13 文件同跑约 1/3 概率报「样本文档未被完整解析」）。用 ensureSyntaxTree
// 阻塞到全文解析就绪（2s 预算，实际毫秒级），解析结果进 state 缓存，后续 syntaxTree(state) 即全树。
const state = EditorState.create({ doc: SAMPLE, extensions: [md()] });
assert.ok(parsed().length > SAMPLE.length - 10, "样本文档未被完整解析");

const covered = new Set<Tag>();
for (const rule of MD_SPEC as { tag?: Tag | readonly Tag[] }[]) {
  if (!rule.tag) continue;
  for (const tg of Array.isArray(rule.tag) ? rule.tag : [rule.tag]) covered.add(tg);
}

test("A 覆盖度：语法树里的每个 tag 要么被着色，要么确认默认样式不管它", () => {
  const leaked: string[] = [];
  for (const tg of treeTags()) {
    if (!covered.has(tg) && !EXEMPT.has(tg)) leaked.push(String(tg.name ?? "?"));
  }
  assert.deepEqual(leaked, [], `这些 tag 会被 CodeMirror 默认配色补色：${leaked.join(", ")}`);
});

test("B1 着色表用到的类名，app.css 里必须有定义", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/styles/app.css", import.meta.url)), "utf8");
  const used = new Set<string>();
  for (const rule of MD_SPEC as { class?: string }[]) if (rule.class) used.add(rule.class);
  used.add("cm-bullet");   // 结构装饰的两个类同样要有 CSS
  used.add("cm-fence-line");
  used.add("cm-quote-line");
  for (const cls of used) {
    assert.ok(css.includes("." + cls), `app.css 缺少 .${cls} —— 有类名没样式，等于没着色`);
  }
});

test("B2 层叠顺序：.cmx-plain 必须早于具体类，否则抹掉行内代码配色", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/styles/app.css", import.meta.url)), "utf8");
  const at = (cls: string) => css.indexOf("." + cls + "{");
  assert.ok(at("cmx-plain") >= 0 && at("cmx-code") >= 0, "两个类都要存在");
  assert.ok(at("cmx-plain") < at("cmx-code"), "cmx-plain 必须排在 cmx-code 之前");
  assert.ok(at("cmx-plain") < at("cmx-head"), "cmx-plain 必须排在 cmx-head 之前");
  // 标记符（灰）排在标题（accent）之后：`#` 与标题文字同 span 时要取灰，与原型 hl-hash 一致
  assert.ok(at("cmx-head") < at("cmx-mark"), "cmx-mark 应晚于 cmx-head");
});

test("C 结构装饰与 GFM 构造：节点确实出现在编辑区解析结果里", () => {
  const names = treeNodes();
  for (const n of ["FencedCode", "CodeBlock", "Blockquote", "ListMark", "TaskMarker", "TableHeader", "ATXHeading1"]) {
    assert.ok(names.has(n), `样本文档应产生 ${n} 节点`);
  }
  // 这三条就是"默认 CommonMark 基"会丢掉的构造——曾经编辑区着色表全对、颜色却出不来
  for (const n of ["Strikethrough", "Task", "Table"]) {
    assert.ok(names.has(n), `${n} 没被解析：编辑区的 markdown base 是不是退回 CommonMark 了？`);
  }
});

test("MD_CLASS 声明的类名都要有对应规则（改了这边要改那边）", () => {
  const classes = new Set<string>();
  for (const rule of MD_SPEC as { class?: string }[]) if (rule.class) classes.add(rule.class);
  for (const c of Object.values(MD_CLASS)) {
    assert.ok(classes.has(c), `${c} 在 MD_CLASS 里声明却没有对应规则`);
  }
});
