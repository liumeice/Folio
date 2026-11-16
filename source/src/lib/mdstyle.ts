/* 编辑区 Markdown 语法着色：把 CodeMirror 的 markdown tag 映射到本项目的主题 token。
 *
 * 基准 = 原型的着色层（prototype/prototype.html:2004-2038 的着色器 + 394-408 的配色表）。
 * 之前 EditorPane 只挂了 basicSetup，它自带的 defaultHighlightStyle 是通用浅色配色
 * （标题加下划线、`###` 灰绿、代码语言名深蓝 rgb(34,17,153)…），在深色主题下既难看又与原型不一致。
 *
 * 这里用 class 而不是内联 color：深浅双主题靠 CSS 变量自动跟随（原型同款机制）。
 * basicSetup 的默认样式带 fallback:true，只要我们覆盖了某个 tag，它就不会再生效。
 *
 * CM6 无法用 tag 区分「行内代码」与「围栏代码」（lezer 把 InlineCode 与 CodeText 都标成
 * monospace）——原型里这两者配色不同（hl-code 带 accent 底纹 / hl-fence 带 frame 底纹）。
 * 因此围栏额外由 fenceLines.ts 给整行加 .cm-fence-line，CSS 用后代选择器把行内样式改成围栏样式。 */
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** 类名前缀 cmx- 以免与 CodeMirror 生成的类名相撞 */
export const MD_CLASS = {
  head: "cmx-head",        // 标题文字
  mark: "cmx-mark",        // # > [ ] ( ) ``` ~ ** 等标记符
  strong: "cmx-strong",
  em: "cmx-em",
  del: "cmx-del",
  code: "cmx-code",        // 行内代码（围栏内由 .cm-fence-line 改写）
  info: "cmx-info",        // ``` 后的语言名
  quote: "cmx-quote",
  link: "cmx-link",
  url: "cmx-url",
  rule: "cmx-rule",
  task: "cmx-task",
  title: "cmx-title",      // 链接 title
  esc: "cmx-esc",
  plain: "cmx-plain",      // 显式"不上色"，见下
} as const;

export const MD_SPEC = [

  // 标题文字：原型 hl-head = accent + 650（**不加下划线**，默认样式那条下划线就是不一致的来源）
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: MD_CLASS.head },
  // 标记符统一 text-3：原型的 hl-hash / hl-lkb / hl-pipe / hl-fence 标记全是 text-3
  { tag: [t.processingInstruction, t.meta, t.separator], class: MD_CLASS.mark },
  { tag: t.strong, class: MD_CLASS.strong },
  { tag: t.emphasis, class: MD_CLASS.em },
  { tag: t.strikethrough, class: MD_CLASS.del },
  { tag: t.monospace, class: MD_CLASS.code },
  { tag: t.labelName, class: MD_CLASS.info },           // CodeInfo（语言名）、LinkLabel
  { tag: t.quote, class: MD_CLASS.quote },
  { tag: t.link, class: MD_CLASS.link },                 // 链接/图片的文字部分
  { tag: t.url, class: MD_CLASS.url },
  { tag: t.contentSeparator, class: MD_CLASS.rule },
  { tag: t.atom, class: MD_CLASS.task },                 // GFM 任务标记 [ ] / [x]
  { tag: t.string, class: MD_CLASS.title },              // 链接 title
  { tag: [t.escape, t.character, t.comment], class: MD_CLASS.esc },
  // 只中性化 t.heading：defaultHighlightStyle（basicSetup 的 fallback）会给它 bold + 下划线，
  // GFM 表头正是 t.heading，不压住就会在库里冒出一条原型没有的下划线。
  // t.list / t.content 不用管——翻遍 defaultHighlightStyle 也没有这两条，中性化它们反而会
  // 盖掉同一 span 上的行内代码配色（引用/表格里的 `code`，实机核对抓到的正是这个）。
  { tag: t.heading, class: MD_CLASS.plain },
];

/* 单独导出实例：spec 数组留作 tests/mdstyle.test.ts 的覆盖度断言之用
 * （HighlightStyle 实例不暴露 spec，测试要读原始数组）。 */
export const mdHighlight = HighlightStyle.define(MD_SPEC);

// 中性类放在最后定义，避免被其它 tag 规则抢掉正文
// （CSS 侧的 .cmx-plain 用 inherit 覆盖默认配色的 color/weight/decoration）
