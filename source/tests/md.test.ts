/* md 内联解析回归断言（递归引擎版）：
 * 链接包图 / 参考式 / 自动链接 / 转义 / title 语法 / 代码段保护 / 强调 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToHtml, renderSnippet, headingMatch } from "../src/lib/md.ts";

const imgAttrs = (html: string) => /<img([^>]*)>/.exec(html)?.[1] ?? "";

test("链接包图片：[![alt](img \"t\")](url) 完整嵌套（远程图自动加载口径，需求方 2026-11-16 定夺）", () => {
  const h = mdToHtml('[![新墨西哥州的船岩](https://example.com/shiprock.jpg "Shiprock, New Mexico")](https://www.flickr.com/photos/example)');
  assert.ok(h.includes('<a href="https://www.flickr.com/photos/example"'), "外层是链接");
  assert.ok(h.includes('src="https://example.com/shiprock.jpg"'), "内层 img src 干净");
  assert.ok(h.includes('title="Shiprock, New Mexico"'), "img title 归位");
  assert.ok(h.includes('alt="新墨西哥州的船岩"'), "alt 提取");
  assert.ok(!h.includes("!["), "无残留原始语法");
});

test("参考式链接：[text][1] + 定义行，标题从定义取", () => {
  const h = mdToHtml('霍比特人住在洞穴里 [hobbit-hole][1]。\n\n[1]: https://en.wikipedia.org/wiki/Hobbit#Lifestyle "Hobbit lifestyles"');
  assert.ok(h.includes('href="https://en.wikipedia.org/wiki/Hobbit#Lifestyle"'), h);
  assert.ok(h.includes("hobbit-hole</a>") || h.includes("hobbit-hole"), "label 渲染");
  assert.ok(!h.includes("[1]:"), "定义行被消费");
});

test("collapsed/shortcut 参考：[] [1] 与裸 [1]", () => {
  const src = '[ref][] 和 [1] 都可用\n\n[ref]: https://a.cn\n[1]: https://b.cn';
  const h = mdToHtml(src);
  assert.ok(h.includes('href="https://a.cn"'), h);
  assert.ok(h.includes('href="https://b.cn"'), h);
});

test("自动链接：<url> 尖括号与裸 URL（尾部中文标点不吸入）", () => {
  assert.ok(mdToHtml("<https://www.example.com/x>").includes('<a href="https://www.example.com/x"'));
  const bare = mdToHtml("看看 https://www.example.com。");
  assert.ok(bare.includes('href="https://www.example.com"'), bare);
  assert.ok(bare.includes("。</p>") || bare.includes(">。</"), "句号留在链接外");
});

test("反斜杠转义：\\[ 不成链接（label 不成立；裸 URL 仍自动链接是正确行为）", () => {
  const h = mdToHtml("\\[not a link\\](https://a.cn)");
  assert.ok(!h.includes(">not a link<"), "label 不得被链化");
  assert.ok(h.includes("[not a link]"), "转义后方括号保留为文本");
});

test("代码段保护：反引号里的链接语法不解析", () => {
  const h = mdToHtml("用 `[x](y)` 表示字面量");
  assert.ok(h.includes("<code>[x](y)</code>"), h);
  assert.ok(!h.includes("<a"), h);
});

test("链接 label 内的强调递归渲染", () => {
  const h = mdToHtml("[**加粗**文字](https://a.cn)");
  assert.ok(h.includes('href="https://a.cn"') && h.includes("<strong>加粗</strong>文字</a>"), h);
});

test("带 title 的图片与单引号/尖括号 URL（回归；远程图自动加载）", () => {
  const attrs = imgAttrs(mdToHtml('![圣胡安山脉](https://example.com/mountain.jpg "圣胡安山脉")'));
  assert.ok(attrs.includes('src="https://example.com/mountain.jpg"') && attrs.includes('title="圣胡安山脉"'), attrs);
  const a2 = imgAttrs(mdToHtml("![x](<./my pic.png> '备注')"));
  assert.ok(a2.includes('src="./my pic.png"') && a2.includes('title="备注"'), a2);
});

test("snake_case 下划线不误斜体，**/~~ 正常", () => {
  const h = mdToHtml("变量 some_var_name 和 **粗** 和 ~~删~~");
  assert.ok(h.includes("some_var_name"), h);
  assert.ok(h.includes("<strong>粗</strong>"), h);
  assert.ok(h.includes("<del>删</del>"), h);
});

test("粗体内侧空白与嵌套引号：** 加粗，'引号' ** 仍是加粗（原型口径回归，2026-11-16）", () => {
  // 原型正则 /\*\*([^*]+)\*\*/ 支持 ** 与内容间的空格；升级递归解析器时一度丢掉该容忍度
  const h1 = mdToHtml("** 加粗，'引号' **");
  assert.ok(h1.includes("<strong>加粗，'引号'</strong>"), h1);
  // 无空格路径不回归（引号本就无辜）
  assert.ok(mdToHtml("**加粗，'引号'**").includes("<strong>加粗，'引号'</strong>"));
  // __ 粗体同规则；尾随空白不进 strong
  assert.ok(mdToHtml("__ 同上 __").includes("<strong>同上</strong>"));
  // 空粗体 **** 仍不成立
  assert.ok(!mdToHtml("****").includes("<strong>"));
});

test("表格/标题/任务清单块层不回归", () => {
  const h = mdToHtml("# T1\n\n| a | b |\n| - | - |\n| 1 | [x](https://c.cn) |\n\n- [ ] 任务 [`k`](y)");
  assert.ok(h.includes('data-sec="1"'), "标题锚点");
  assert.ok(h.includes('href="https://c.cn"') && h.includes(">x</a></td>"), "表格单元内联");
  assert.ok(h.includes('data-task="1"'), "任务项");
});

test("~~~ 不再当围栏（与 Rust 口径统一）", () => {
  const h = mdToHtml("~~~\n# 井号仍在大纲\n~~~");
  assert.ok(h.includes('data-sec="1"'), "~~~ 内标题参与编号（与 folio-core 一致）");
});

test("GFM Callout：五类类型 → 图标+色类+默认标题", () => {
  for (const [type, label] of [["NOTE", "说明"], ["TIP", "提示"], ["IMPORTANT", "重要"], ["WARNING", "警告"], ["CAUTION", "危险"]] as const) {
    const h = mdToHtml(`> [!${type}]\n> 内容文字`);
    assert.ok(h.includes(`class="callout co-${type.toLowerCase()}"`), h.slice(0, 80));
    assert.ok(h.includes(`i-co-${type.toLowerCase()}`), "图标");
    assert.ok(h.includes(`<span>${label}</span>`), "默认标题");
    assert.ok(h.includes("内容文字"), "body 渲染");
  }
});

test("Callout：自定义标题 / 折叠变体 / 未知类型回落引用块", () => {
  const c = mdToHtml('> [!WARNING] 上线前必读\n\n> 小心');
  assert.ok(c.includes("<span>上线前必读</span>"), c);
  const f = mdToHtml("> [!CAUTION]-\n> 藏起来");
  assert.ok(f.includes('folded') && f.includes('data-fold="1"') && f.includes('aria-expanded="false"'), f);
  const p = mdToHtml("> [!NOTE]+\n> 展开");
  assert.ok(p.includes('data-fold="1"') && !p.includes("folded\""), p);
  const bad = mdToHtml("> [!SOMETHING]\n> 普通引用");
  assert.ok(bad.startsWith("<blockquote") && bad.includes("[!SOMETHING]"), bad.slice(0, 80));
});

test("表格：代码段内的 | 不分列（用户样例）", () => {
  const h = mdToHtml('| Command | Description |\n| - | - |\n| `cat file | claude -p "query"` | 处理管道内容 | `cat logs.txt | claude -p "explain"` |');
  assert.ok(h.includes("<table>"), "仍是表格");
  const rows = h.match(/<tr[^>]*>.*?<\/tr>/gs) ?? [];
  assert.equal(rows.length, 2, "表头 1 行 + 数据 1 行");
  assert.equal((rows[1].match(/<td>/g) ?? []).length, 3, "数据行恰好 3 列");
  assert.ok(h.includes("<code>cat file | claude -p &quot;query&quot;</code>"), "代码段完整：\n" + h);
  assert.ok(h.includes("<td>处理管道内容</td>"), "中间列不错位");
});

test("表格：转义 \\| 作为字面量不分列", () => {
  const h = mdToHtml("| a | b |\n| - | - |\n| x \\| y | z |");
  const body = h.slice(h.indexOf("<tbody>"));
  assert.equal((body.match(/<td>/g) ?? []).length, 2, "应恰好 2 列：" + body);
  assert.ok(body.includes("x | y"), "转义还原为字面 |：" + body);
});

test("GFM emoji：点名符号与别名替换", () => {
  const h = mdToHtml(":rocket: :thumbsup: :star: :warning: :white_check_mark: :+1: :-1: :bug:");
  assert.ok(h.includes("🚀") && h.includes("👍") && h.includes("⭐") && h.includes("⚠️") && h.includes("✅"), h);
  assert.ok(h.includes("👍") && h.includes("👎"), "+1/-1 别名");
  assert.ok(!h.includes(":+1:") && !h.includes(":-1:"), "别名无残留");
  assert.ok(h.includes("🐛"), "bug");
  assert.ok(!h.includes(":rocket:") && !h.includes(":thumbsup:"), "无残留短代码");
});

test("emoji：强调内可替换，代码段与 URL 内不替换", () => {
  assert.ok(mdToHtml("**:fire: 热点**").includes("<strong>🔥 热点</strong>"));
  const c = mdToHtml("字面量 `:rocket:` 保留");
  assert.ok(c.includes("<code>:rocket:</code>"), c);
  const u = mdToHtml("https://ex.com/t/:star: 结尾");
  assert.ok(!u.includes("⭐"), "URL 文本不出 emoji：" + u);
});

test("emoji：未知短代码原样保留（GitHub 行为）", () => {
  const h = mdToHtml(":not_a_real_one: 和 :rocket:");
  assert.ok(h.includes(":not_a_real_one:") && h.includes("🚀"), h);
});

test("Callout：嵌套列表/代码正常渲染，普通 blockquote 不回归", () => {
  const h = mdToHtml("> [!TIP]\n> - 要点一\n> - 要点二");
  assert.ok(/<ul[ >]/.test(h) && h.includes("要点一"), h);
  const q = mdToHtml("> 普通引用文字");
  assert.ok(q.startsWith("<blockquote"), q.slice(0, 40));
});

/* ══════ loose 列表回归（需求方 2026-11-17 缺陷：条目间空行导致每段都显示 1.）══════ */

test("loose 有序列表：空行分条=同一列表；续行正文/项内 callout 并进 <li>；容器 start=源编号", () => {
  const h = mdToHtml("1. **A**\n\n   正文一\n\n2. **B**\n\n   > [!TIP]\n   > 提示\n\n3. **C**");
  assert.equal((h.match(/<ol[\s>]/g) ?? []).length, 1, "loose 条目不得断列表：" + h);
  assert.ok(h.includes('<ol start="1"'), h);
  assert.ok(/<li data-line-start="0" data-line-end="2">/.test(h), "续行正文并进 li、行锚尾随扩行：" + h);
  assert.ok(/<li data-line-start="4" data-line-end="7">/.test(h), "项内 TIP callout 并进 li 且扩行");
  assert.ok(h.includes("提示") && h.includes("<strong>C</strong>"), h);
});

test("标题切断列表并重新计数；被切断的新列表用作者编号兜底（4. 永远显示 4）", () => {
  const h = mdToHtml("# 一\n\n1. a\n\n# 二\n\n4. d");
  assert.equal((h.match(/<ol[\s>]/g) ?? []).length, 2, "标题必然收表：" + h);
  assert.ok(h.includes('<ol start="1"') && h.includes('<ol start="4"'), "start=该列表首项源编号：" + h);
  const t = mdToHtml("1. a\n\n2. b\n\n- x\n\n4. d");
  assert.ok(t.includes('<ol start="4"'), "类型切换切断同样保留作者编号：" + t);
});

/* ══════ 审查报告 v1.0 整改回归（2026-11-16）══════ */

test("SEC-01：renderSnippet 先转义再换 <em>——恶意 .md 的 HTML 只会以字面文本出现", () => {
  const h = renderSnippet('正常 «<img src=x onerror=alert(1)>» 更多 <script>alert(2)</script> & "quoted"');
  assert.ok(!h.includes("<img"), h);
  assert.ok(!h.includes("<script>"), h);
  assert.ok(h.includes("&lt;img"), "标签转为实体");
  assert.ok(h.includes("<em>&lt;img src=x onerror=alert(1)&gt;</em>"), "命中词包进 em 且已转义：" + h);
  // «» 标记本身不参与转义替换以外的语义
  assert.ok(!/«|»/.test(h), "标记不残留");
});

test("CON-01：引用块/提示块内任务不生成 data-task（勾选坐标系与 Rust toggle_task 同源）", () => {
  const h = mdToHtml("> - [ ] quoted\n>\n> > [!NOTE]\n> > - [ ] inCallout\n\n- [ ] first\n\n- [ ] second");
  assert.equal((h.match(/data-task/g) ?? []).length, 2, "只有顶层两篇参与序号：" + h);
  assert.ok(h.includes('aria-hidden="true"'), "引用内任务是静态展示（不可点、不写回）");
  const topOnly = mdToHtml("- [ ] a\n\n> - [ ] q\n\n- [ ] b");
  assert.equal((topOnly.match(/data-task/g) ?? []).length, 2, "引用内任务不占序号：" + topOnly);
});

test("CON-01 边界：\"- [ ]x\"（]) 后无空格）也算任务——Rust task_parts 不要求 ] 后空白", () => {
  const h = mdToHtml("- [ ]x\n\n- [ ] y");
  assert.equal((h.match(/data-task/g) ?? []).length, 2, h);
});

test("CON-02：引用块/提示块标题不占 data-sec、id 不重复；缩进标题与裸 # 按 Rust 口径计数", () => {
  const h = mdToHtml("# Top\n\n> # Quoted\n\n## Sub\n\n> [!NOTE]\n> # InCallout\n\n    # Indented\n\n#\n");
  assert.equal((h.match(/id="sec-1"/g) ?? []).length, 1, "不得有重复 id");
  assert.equal((h.match(/data-sec=/g) ?? []).length, 4, "Top/Sub/Indented/裸# 四个锚点：" + h);
  assert.ok(h.includes('data-sec="3"') && h.includes('data-sec="4"'), "缩进与空标题占号（与 headings() 一致）");
  assert.ok(h.includes('<h1 data-line-start="2" data-line-end="2">Quoted</h1>'), "引用块标题渲染但无锚点（行锚按 baseLine 记绝对行）");
  assert.ok(h.includes('<h1 data-line-start="7" data-line-end="7">InCallout</h1>'), "提示块标题同理");
});

/* ══════ 滚动同步 v1.2：块锚 data-line-start/end 记账回归 ══════ */

test("块锚：标题行号与源行一致；段/围栏/表格/列表各记起止", () => {
  const h = mdToHtml("# A\n\n正文一段\n第二行\n\n```js\nconst x=1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- 甲\n- 乙");
  assert.ok(h.includes('<h1 id="sec-1" data-sec="1" data-sec-text="A" data-line-start="0" data-line-end="0">'), h);
  assert.ok(h.includes('<p data-line-start="2" data-line-end="3">'), "段落记首末行");
  assert.ok(h.includes('<div class="codeblock" data-line-start="5" data-line-end="7">'), "围栏整体含界行");
  assert.ok(h.includes('<pre data-line-start="6" data-line-end="6">'), "pre 子锚只含内容行");
  assert.ok(h.includes('<div class="tw-tbl" data-line-start="9" data-line-end="11">'), "表格起止");
  assert.ok(/<li data-line-start="13" data-line-end="13">\n甲\n<\/li>/.test(h), "li 逐项行锚（三段式输出）");
  assert.ok(/<ul data-line-start="13" data-line-end="14">/.test(h), "ul 容器回填起止");
});

test("块锚：mermaid 围栏起止含界行，预估高度在属性上；未闭合围栏吃到 EOF", () => {
  const h = mdToHtml("```mermaid\ngraph TD\nA-->B\n```");
  assert.ok(h.includes('data-line-start="0" data-line-end="3"'), h);
  assert.ok(/ style="min-height:\d+px"><\/div>/.test(h), h);
  const open = mdToHtml("段落\n\n```mermaid\ngraph TD");
  assert.ok(open.includes('data-line-start="2" data-line-end="3"'), "未闭合 → 到末行：" + open);
});

test("块锚：引用/Callout 内子块经 baseLine 记绝对行；嵌套不占 data-sec", () => {
  const h = mdToHtml("导言\n\n> [!NOTE]\n> 内段一\n> 内段二\n\n> 普通引用");
  // 行：0 导言；1 空；2 [!NOTE] 标题行；3-4 body；5 空；6 引用
  assert.ok(h.includes('<div class="callout co-note" data-callout="note" data-line-start="2" data-line-end="4">'), h);
  assert.ok(h.includes('<p data-line-start="3" data-line-end="4">'), "callout 内段落=绝对行（baseLine 平移）");
  assert.ok(h.includes('<blockquote data-line-start="6" data-line-end="6">'), h);
});

test("块锚：$$ 块内被吞的标题/任务照常占号；rawblk 包裹层记范围", () => {
  const h = mdToHtml("$$\n# 被吞标题\n$$\n\n<p align=\"center\">徽章</p>\n\n正文");
  assert.ok(h.includes('<div class="f-block" data-math="block" data-lang="tex" data-code="# 被吞标题" data-line-start="0" data-line-end="2"'), h);
  assert.ok(h.includes('<div class="rawblk" data-line-start="4" data-line-end="4">'), h);
  assert.ok(h.includes('<p data-line-start="6" data-line-end="6">正文</p>'), h);
  assert.ok(!h.includes('data-sec="1"'), "被吞标题不产锚点（占号但无 DOM 锚，与 CON-02 口径一致）");
});

test("块锚：hr 记零跨度行；空文档零输出不炸", () => {
  const h = mdToHtml("上\n\n---\n\n下");
  assert.ok(h.includes('<hr data-line-start="2" data-line-end="2">'), h);
  assert.equal(mdToHtml(""), "");
});

test("CON-02：headingMatch 与 Rust 逐条同判", () => {
  assert.deepEqual(headingMatch("  # 缩进"), { level: 1, text: "缩进" });
  assert.deepEqual(headingMatch("#"), { level: 1, text: "" });
  assert.deepEqual(headingMatch("## 尾闭 ##"), { level: 2, text: "尾闭" });
  assert.deepEqual(headingMatch("# foo#"), { level: 1, text: "foo#" }, "紧贴的 # 不剥离（Rust 语义）");
  assert.equal(headingMatch("#tag"), null);
  assert.equal(headingMatch("####### 七号"), null);
  assert.equal(headingMatch("> 引用里"), null);
  assert.equal(headingMatch("正文"), null);
});

test("远程图片自动加载（需求方定夺取代 SEC-04 拦截方案）：src 直出 + lazy，失败态归 watchImg", () => {
  const h = mdToHtml("![a](https://e.com/x.png)\n\n![b](//e.com/y.png)\n\n![c](./local.png)");
  assert.equal((h.match(/<img/g) ?? []).length, 3, "远程两枚 + 本地一枚全部直出 img：" + h);
  assert.ok(h.includes('src="https://e.com/x.png"') && h.includes('src="//e.com/y.png"'), h);
  assert.ok(h.includes('loading="lazy"'), "懒加载保留，长文档不一次拉全");
  assert.ok(!h.includes("imgdefer"), "占位机制已废弃");
});
