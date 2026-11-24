/* md 内联解析回归断言（递归引擎版）：
 * 链接包图 / 参考式 / 自动链接 / 转义 / title 语法 / 代码段保护 / 强调 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToHtml, renderSnippet, headingMatch, flipTaskInSrc, headingsOfSrc, lineKinds, setSoftBreakBr } from "../../src/lib/md.ts";

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

test("粗体内侧空白=字面文本（2026-11-22 需求方定夺：CommonMark 口径取代 2026-11-16 原型宽容度）", () => {
  // cmark 6.5：定界符后紧跟空白不满足 left-flanking → 不成强调（官方例 #379/#391/#397），与 GitHub 实渲一致。
  // 旧原型 /\*\*([^*]+)\*\*/ 的对称内侧空格宽容度据此废止；存量笔记里 `** 文字 **` 写法将显示为字面。
  assert.ok(!mdToHtml("** 加粗，'引号' **").includes("<strong>"), "对称内侧空白 → 字面");
  assert.ok(!mdToHtml("** foo bar**").includes("<strong>"), "非对称同样字面");
  assert.ok(!mdToHtml("__ 同上 __").includes("<strong>"));
  // 无空格路径正常渲染（引号本就无辜）
  assert.ok(mdToHtml("**加粗，'引号'**").includes("<strong>加粗，'引号'</strong>"));
  // 空粗体 **** 仍不成立
  assert.ok(!mdToHtml("****").includes("<strong>"));
});

test("表格/标题/任务清单块层不回归", () => {
  const h = mdToHtml("# T1\n\n| a | b |\n| - | - |\n| 1 | [x](https://c.cn) |\n\n- [ ] 任务 [`k`](y)");
  assert.ok(h.includes('data-sec="1"'), "标题锚点");
  assert.ok(h.includes('href="https://c.cn"') && h.includes(">x</a></td>"), "表格单元内联");
  assert.ok(h.includes('data-task="1"'), "任务项");
});

/* 2026-11-21 第二档：围栏从"只认 ```（toggle 式）"升级为 ```/~~~ 配对（闭栏=同字符且长度≥开栏）。
 * 本测试与 folio-core second_batch_kinds_gfm 镜像双跑。 */
test("~~~ 当围栏 + 变长配对（第二档，与 folio-core 镜像）", () => {
  const h = mdToHtml("~~~\n# 假标题(围栏内)\n~~~\n\n# 真标题");
  assert.ok(h.includes("<pre"), "~~~ 块渲染为代码： " + h);
  assert.ok(!h.includes("data-sec-text=\"假标题(围栏内)\""), "~~~ 内标题不参与编号");
  assert.ok(h.includes('data-sec="1"') && h.includes("真标题"), "闭栏后恢复大纲");
  const t = mdToHtml("````md\n``` js\n# 内层是内容\n```\n````\n# 出栏\n");
  assert.ok(!t.includes('data-sec-text="内层是内容"'), "四反引号内三反引号是内容（短闭无效）");
  assert.ok(t.includes('data-sec="1"') && t.includes("出栏"), "长栏被同行数长栏关闭");
  const u = mdToHtml("~~~\n```\n# 仍围栏内\n");
  assert.ok(u.includes("# 仍围栏内"), "未闭合围栏吃到 EOF，整段是代码");
  assert.ok(!u.includes("data-sec"), "异种闭栏不闭合：~~~ 内 ``` 只是内容");
});

test("第二档·Setext 标题：=→h1、-→h2；锚点行号记段落首行（Rust second_batch_kinds_gfm 镜像）", () => {
  const h = mdToHtml("标题一\n=====\n\n小节\n---\n\n正文\n");
  assert.ok(h.includes('data-sec-text="标题一"'), "标题一=h1：" + h);
  assert.ok(h.match(/<h1[^>]*data-line-start="0"/), "= 出 h1，块锚从段落首行起");
  assert.ok(h.includes('data-sec-text="小节"') && h.match(/<h2[^>]*data-line-start="3"/), "- 出 h2，行号=段落首行 3");
  const hr = mdToHtml("段落\n\n---\n\n再段\n===\n");
  assert.ok(hr.includes("<hr"), "空行断开：--- 是 hr 不是 setext");
  assert.equal((hr.match(/data-sec=/g) ?? []).length, 1, "只有贴段落的 === 计标题");
  assert.equal((mdToHtml("---\n正文\n").match(/data-sec=/g) ?? []).length, 0, "无前置段落 --- 不占号");
  const multi = mdToHtml("首行\n次行\n===\n");
  assert.ok(multi.includes('data-sec-text="首行 次行"'), "多行段落升格：逐行连接 " + multi);
  // 代码围栏内的 ===/--- 不是 setext（fi 行不接段落）
  const fence = mdToHtml("段落\n```\n===\n```\n");
  assert.equal((fence.match(/data-sec=/g) ?? []).length, 0, "围栏内 === 只是代码");
});

test("第二档·缩进代码与懒延续（Rust line_kinds 三分流镜像）", () => {
  const h = mdToHtml("# 前\n\n      # 缩进代码\n");
  assert.equal((h.match(/data-sec=/g) ?? []).length, 1, "非列表语境深缩进 # = 缩进代码不计");
  assert.ok(h.includes('<code class="language-text">  # 缩进代码</code>'), "6 列只剥 4 列，余 2 列保留在代码内：" + h.slice(-220));
  const lazy = mdToHtml("段落文字\n    # 懒延续\n");
  assert.equal((lazy.match(/data-sec=/g) ?? []).length, 0, "贴段落的 ≥4 列 = 懒延续正文");
  assert.ok(lazy.includes("# 懒延续"), "正文仍可见");
  const inList = mdToHtml("- a\n    # 项内标题\n");
  assert.ok(inList.includes('data-sec="1"'), "列表后 4 列 ATX：宽松口径计标题（已批准偏差）");
  const tab = mdToHtml("\t# 制表符标题\n");
  assert.equal((tab.match(/data-sec=/g) ?? []).length, 0, "Tab=4 列：顶格 tab 的 ATX 是缩进代码");
  // 代码运行吸收空行：``` 在 code run 内只是内容（Rust prev==Code 分支）
  const run = mdToHtml("    a\n\n    ```\n\n尾段\n");
  assert.ok(run.includes("<pre"), "``` 行被代码 run 吸收");
  assert.ok(run.includes("尾段"), "run 止于非缩进行");
});

test("第二档·任务坐标：围栏/缩进代码/懒延续假任务全出局（Rust second_batch_task_coordinate 镜像）", () => {
  const src = "~~~\n- [ ] 围栏内假\n~~~\n\n```js\n- [ ] 反引号内假\n```\n\n# 标题\n\n    - [ ] 缩进代码假\n\ntext\n    - [ ] 懒延续假\n\n- [ ] 真一\n";
  const out = flipTaskInSrc(src, 0);
  assert.ok(out!.includes("- [x] 真一"), "有且仅有一个真任务：" + out);
  assert.equal(flipTaskInSrc(out!, 1), null, "假任务全部出局");
});

test("P2·输入预处理：裸 CR 分行、NUL→U+FFFD（↔ Rust p2_batch_input_normalization）", () => {
  const h = mdToHtml("# 标题一\r# 标题二\r\n正文\r    # 代码行\r");
  assert.equal((h.match(/data-sec=/g) ?? []).length, 2, "裸 CR 分行、分行后 4 列=懒延续：" + h.slice(0, 200));
  assert.ok(h.includes('data-sec-text="标题二"'), "第二行标题按行界识别");
  const nul = mdToHtml("# 标题" + String.fromCharCode(0) + "甲\n");
  assert.ok(nul.includes("标题" + String.fromCharCode(0xFFFD) + "甲"), "NUL 以 U+FFFD 显示");
  assert.ok(!nul.includes(String.fromCharCode(0)), "输出不含裸 NUL");
  assert.equal(flipTaskInSrc("- [ ] a\r- [ ] b\n", 1), "- [ ] a\r- [x] b\n", "混合行尾逐字节保留（↔ Rust toggle）");
  assert.equal(flipTaskInSrc("  1. [ ] x\n", 0), "  1. [x] x\n");
});

test("P2·邮箱自动链接收紧（cmark-gfm localpart）与标签名 999 上限、空 tbody 钉桩", () => {
  assert.ok(!mdToHtml("x a.@b.com y").includes("mailto:"), "localpart 尾点不自动链接");
  assert.ok(!mdToHtml("x a..b@c.io y").includes("mailto:"), "连续特殊符不自动链接");
  assert.ok(!mdToHtml("x +tag@y.com y").includes("mailto:"), "起始特殊符不自动链接");
  assert.ok(mdToHtml("联络 foo.bar+b@sub.example.com 谢谢").includes('href="mailto:foo.bar+b@sub.example.com"'), "合法形态照常链接");
  const long = mdToHtml("甲 <" + "b".repeat(1000) + ">x");
  assert.ok(long.includes("&lt;"), "标签名 >999 字符不成标签（转义可见）：" + long.slice(0, 60));
  assert.ok(mdToHtml("甲 <kbd>K</kbd> 尾").includes("<kbd>K</kbd>"), "正常标签不受影响");
  assert.ok(!mdToHtml("| a | b |\n|---|---|\n").includes("<tbody"), "只有表头的表格不输出空 tbody");
  const t = mdToHtml("- a\n\t- b\n");
  assert.equal((t.match(/<ul/g) ?? []).length, 2, "Tab 缩进按 4 列制表位算嵌套深度：" + t);
});

test("第五批·cmark 引擎+快赢：跨原子强调、dedent 围栏、info 反引号、数字标记上限、start=0", () => {
  // cmark 分隔符栈：跨代码段/链接的强调配对（旧正则不可达）
  assert.ok(mdToHtml("*a `*`*").includes("<em>a <code>*</code></em>"), "跨 code 配对");
  assert.ok(mdToHtml("**foo [x](/u)**").includes("<strong>foo <a"), "跨 link 配对");
  assert.ok(mdToHtml("*foo [bar](/url)*").includes("<em>foo <a"), "em 包 link");
  assert.ok(!mdToHtml("** foo bar**").includes("<strong>"), "cmark flanking：开符后空白不成粗（#379）");
  assert.ok(mdToHtml("пристаням_стремятся_").indexOf("<em>") === -1, "俄文词内下划线不强调（#362）");
  // 硬换行进内联层：代码段/属性不再被控制符污染，段末反斜杠不丢
  assert.ok(!mdToHtml("`code  \nspan`").includes(String.fromCharCode(2)), "code span 无控制符（#640）");
  assert.equal(flipTaskInSrc("foo\\\n", 0), null);
  assert.ok(mdToHtml("foo\\\n").includes("foo\\"), "段末反斜杠保留（#644）");
  // 围栏内容按开栏缩进 dedent（#131-133）
  const d = mdToHtml(" ```\n aaa\naaa\n ```\n");
  assert.ok(/<code[^>]*>aaa\naaa<\/code>/.test(d), "dedent：" + d.slice(0, 220));
  // CC 4.5 info 反引号拒开栏 / CC 5.2 数字标记 ≤9 位 / start=0 保真（↔ Rust cm_quick）
  const ib = mdToHtml("``` ```\n# 真标题\n");
  assert.ok(!ib.includes("language-```") && ib.includes('data-sec="1"'), "info 反引号：" + ib.slice(0, 140));
  assert.equal((mdToHtml("1234567890. [ ] 十位\n").match(/data-task/g) ?? []).length, 0);
  assert.equal(flipTaskInSrc("1234567890. [ ] x\n", 0), null, "十位标记不是任务");
  assert.ok(flipTaskInSrc("0. [ ] a\n", 0)!.includes("[x]"), "0. 仍是任务");
  assert.ok(mdToHtml("0. a\n").includes('start="0"'), "start=0");
  // emoji 短码不再被定界符拆分打碎（文本并拢回归）
  assert.ok(mdToHtml("通过 :white_check_mark: 标记").includes("✅"), "短码跨 _ 碎片合并");
});

test("GitHub 扩展·YAML front matter：元数据卡直出，区内不产标题/任务（↔ Rust front_matter_skipped）", () => {
  const src = "---\ntitle: 示例文档\ntags: [gfm, folio]\n---\n\n# 正文标题\n正文";
  const h = mdToHtml(src);
  assert.ok(h.includes('class="frontmatter"') && h.includes('<span class="fmk">title</span>'), h.slice(0, 140));
  assert.equal((h.match(/data-sec=/g) ?? []).length, 1, "收口 --- 不再变 Setext h2");
  assert.deepEqual(headingsOfSrc(src).map((x) => [x.sec, x.level, x.line]), [[1, 1, 5]], "行号按绝对行计（0 起，含头部区与空行）");
  assert.equal((mdToHtml("---\nt: x\n...\n\n# A\n").match(/data-sec=/g) ?? []).length, 1, "... 收口同样认");
  assert.equal((mdToHtml("---\n# 不是头部\n").match(/data-sec=/g) ?? []).length, 1, "无收口→普通 hr+ATX");
  assert.ok(flipTaskInSrc("---\n- [ ] yaml假任务\n---\n\n- [ ] 真\n", 0)!.includes("[x] 真"), "头部假任务出局");
  assert.ok(flipTaskInSrc("---\n- [ ] yaml\n---\n\n- [ ] a\n\n- [ ] b\n", 1)!.includes("[x] b"), "序号对齐");
  // 收紧判据（↔ Rust #96/#98 防护）：裸文本/空 body 不算头部
  const n96 = mdToHtml("---\nFoo\n---\nBar\n---\nBaz\n");
  assert.equal((n96.match(/<h2[^>]*>/g) ?? []).length, 2, "#96 Foo/Bar 是 Setext h2 序列：" + n96.slice(0, 140));
  assert.ok(!n96.includes("frontmatter"));
  const n98 = mdToHtml("---\n---\n");
  assert.equal((n98.match(/<hr/g) ?? []).length, 2, "#98 空 body 不算头部");
  // 多键 YAML 仍是头部
  assert.ok(mdToHtml("---\ntitle: T\ntags: [a]\nauthor: X\n---\n\n# 正文\n").includes("frontmatter"), "多键 YAML");
});

test("GitHub 扩展·脚注：首引编号/定义内嵌 Markdown/未定义回落/任务坐标占位（↔ 样例 8.5）", () => {
  const src = "A[^b] 与 B[^a]，C[^b] 再来，X[^没] 未定义。\n\n- [ ] 真任务\n\n[^a]: 先定义\n  但**不先**被引用。\n[^b]: 后定义\n";
  const h = mdToHtml(src);
  assert.deepEqual([...h.matchAll(/href="#fn-(\d)"/g)].map((m) => m[1]), ["1", "2", "1"], "编号按引用首次出现（b=1 a=2）：" + h.slice(0, 150));
  assert.equal((h.match(/id="fnref-1"/g) ?? []).length, 1, "回跳锚只给首个引用");
  assert.ok(h.includes("<strong>不先</strong>"), "定义内 Markdown 生效");
  assert.ok(h.includes("[^没]"), "无定义标签回落字面文本");
  const sec = h.slice(h.indexOf('class="footnotes"'));
  assert.ok(sec.includes('<li id="fn-1">') && sec.indexOf("后定义") < sec.indexOf("先定义"), "汇总节按编号排序");
  assert.ok(sec.includes('href="#fnref-2"'), "回跳链接");
  assert.equal((h.match(/data-task/g) ?? []).length, 1, "真任务 data-task 单枚");
  // 定义块含真任务：占位打在定义位置，DOM 文档序 ↔ Rust 计数一致
  const src2 = "任务[^f]引用。\n\n- [ ] 真一\n\n[^f]: 注意\n  - [ ] 注内任务\n";
  const h2 = mdToHtml(src2);
  assert.equal((h2.match(/data-task/g) ?? []).length, 2, "定义内任务 → 隐藏占位保持序号");
  assert.ok(flipTaskInSrc(src2, 1)!.includes("[x] 注内任务"), "Rust 同坐标：注内任务计 1");
});

test("第四批·标记切换开新表 / 表格入项 / 项内定义 / 多段项 loose", () => {
  const mk = mdToHtml("- a\n* b\n+ c\n");
  assert.equal((mk.match(/<ul/g) ?? []).length, 3, "三种项目符号=三个列表：" + mk);
  assert.equal((mdToHtml("- a\n- b\n").match(/<ul/g) ?? []).length, 1, "同符号仍同一列表");
  assert.equal((mdToHtml("1. a\n2) b\n").match(/<ol/g) ?? []).length, 2, ". 与 ) 分隔符不同=新列表");
  const tb = mdToHtml("- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n");
  assert.ok(tb.slice(tb.indexOf("<ul"), tb.indexOf("</ul>")).includes("<table>"), "表格并入 <li>：" + tb.slice(0, 100));
  const df = mdToHtml("- [ref-f]: /url\n\n见 [ref-f]\n");
  assert.ok(df.includes('href="/url"') && df.includes("<li"), "项内定义注册且项体空：" + df);
  const mp = mdToHtml("- 第一段\n\n  第二段。\n");
  assert.ok(mp.includes("<p>第一段</p>") && mp.includes("<p>第二段。</p>"), "loose 项两段各包 <p>：" + mp);
});

test("第三档·audit 4.6-c/4.7-c/6.7-a：HTML 块起始白名单、定义不打断段落、alt 实体透传", () => {
  // 4.6-c：行首行内标签带同行内容 → 段落，不再吞掉后续 Markdown
  const sp = mdToHtml("<span>hi</span>\n**bold**");
  assert.ok(sp.includes("<span>hi</span>") && sp.includes("<strong>bold</strong>"), sp);
  // 类型 6 块标签：行首可带后续内容仍开块（rawblk 包裹、块内不跑内联解析）。
  // 注：md.test 无 jsdom，sanitizeHtml 走全转义回退——结构断言在 html.test.ts（有 DOM）做。
  const dt = mdToHtml("<details>\n<summary>x</summary>\n*不强调*\n</details>");
  assert.ok(dt.includes('class="rawblk"') && !dt.includes("<em>"), "类型 6 开块、块内不做内联：" + dt.slice(0, 60));
  // 类型 7：非块标签独占整行才开块
  const alone = mdToHtml("<span>\nhi\n</span>");
  assert.ok(alone.includes('class="rawblk"'), "整行单标签=类型 7 块：" + alone.slice(0, 60));
  // 4.7-c：紧邻段落的定义行不成立（段落文本、不注册）；空行后恢复可注册
  const dp = mdToHtml("para\n[x]: /u\n\n用 [x] 尾");
  assert.ok(dp.includes("[x]: /u") && !dp.includes('href="/u"'), dp.slice(0, 120));
  const dd = mdToHtml("[a]: /1\n[b]: /2\n\n见 [a] 与 [b]");
  assert.ok(dd.includes('href="/1"') && dd.includes('href="/2"'), "连排定义都成立：" + dd);
  const ok2 = mdToHtml("段落\n\n[x]: /u\n\n用 [x]");
  assert.ok(ok2.includes('href="/u"'), "空行断开后定义成立");
  // 6.7-a：alt/title 实体透传（浏览器解码），字面 & 仍安全转义
  const im = mdToHtml("![AT&amp;T](/u)");
  assert.ok(im.includes('alt="AT&amp;T"') && !im.includes("&amp;amp;"), im);
  assert.ok(mdToHtml("![AT&T](/u)").includes('alt="AT&amp;T"'), "字面 & 转成实体");
  assert.ok(mdToHtml('[x](/u "a &amp; b")').includes('title="a &amp; b"'), "title 同通道");
});

test("第二档·P1 内联收尾：全空格代码段、标题转义引号、嵌套链接、引用懒延续", () => {
  assert.ok(mdToHtml("`   `").includes("<code>   </code>"), "纯空白 code span 不剥空格（CC 6.1）");
  const t = mdToHtml('[x](u "a\\"b")');
  assert.ok(t.includes('title="a&quot;b"') && t.includes('href="u"'), "title 内转义引号不截断：" + t);
  const nest = mdToHtml("[外 [内](i) 还](o)");
  assert.ok(!nest.includes('<a href="o"'), "外层嵌套链接不成立：" + nest);
  assert.ok(nest.includes('<a href="i"'), "内层链接照常");
  const q = mdToHtml("> 第一行\n懒延续第二行\n\n完");
  assert.ok(/<blockquote[^>]*>(?:(?!<\/blockquote>)[\s\S])*?懒延续第二行/.test(q), "懒延续行并入引用块：" + q);
  const q2 = mdToHtml("> 引用\n- 列表项不并入");
  assert.ok(!/<blockquote[^>]*>(?:(?!<\/blockquote>)[\s\S])*?列表项/.test(q2), "列表行开新块，不懒并入：" + q2);
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
  // GFM 4.10（2026-11-21 P0）：数据行多于表头列数的单元**截断**——表头 2 列则数据行也 2 列
  assert.equal((rows[1].match(/<td>/g) ?? []).length, 2, "数据行截断到表头列数");
  assert.ok(h.includes("<code>cat file | claude -p &quot;query&quot;</code>"), "代码段完整：\n" + h);
  assert.ok(h.includes("<td>处理管道内容</td>"), "中间列不错位");
});

test("表格对齐：分隔行冒号标记落到 th/td 的 inline text-align（2026-11-21 需求）", () => {
  const h = mdToHtml("| 中 | 右 | 左 | 默认 |\n| :---: | ---: | :--- | --- |\n| a | b | c | d |\n| e | f | g | h |");
  // 表头与数据行都带同款对齐样式；无冒号列不输出 style
  assert.ok(h.includes('<th style="text-align:center">中</th>'), "表头居中：" + h.slice(0, 160));
  assert.ok(h.includes('<th style="text-align:right">右</th>'), "表头右");
  assert.ok(h.includes("<th>默认</th>"), "默认列不带样式");
  assert.ok(h.includes('<td style="text-align:center">a</td>') && h.includes('<td style="text-align:center">e</td>'), "数据行居中（两行都生效）");
  assert.ok(h.includes('<td style="text-align:right">b</td>'), "数据行右");
  assert.ok(h.includes("<td>d</td>"), "数据行默认列无样式");
  // 行溢出列数（GFM 4.10）：数据行比表头多出的单元截断丢弃
  const o = mdToHtml("| a | b |\n| :-: | :-: |\n| 1 | 2 | 3 |");
  assert.ok(!o.includes("3"), "第 3 列被截断");
  assert.ok(o.includes('<td style="text-align:center">2</td>'), "表头内列正常");
  // 坐标记账不受影响
  assert.ok(h.includes('data-line-start="2" data-line-end="2"'), "首数据行子锚不变");
});

test("表格单元格：<br> 系换行 + 行内 HTML 白名单口径（2026-11-21 P0）", () => {
  const h = mdToHtml("| 表头一<br>二 | 甲 | 乙 | 丙 |\n| - | - | - | - |\n| a<br>b | c<BR/>d | e<br />f | <b>粗</b> <script>x</script> |");
  // 表头与正文单元放行四种写法：<br> <BR/> <br />（大小写/自闭合归一）
  assert.ok(h.includes("<th>表头一<br>二</th>"), "表头 <br>：" + h.slice(0, 160));
  assert.ok(h.includes("<td>a<br>b</td>"), "正文 <br>");
  assert.ok(h.includes("<td>c<br>d</td>"), "<BR/> 归一为 <br>");
  assert.ok(h.includes("<td>e<br>f</td>"), "<br /> 归一为 <br>");
  // 行内 HTML 白名单：ALLOW 标签真渲染；script 不在名单 → tag-filter 转义可见（比删除不易丢内容）
  assert.ok(h.includes("<b>粗</b>"), "b 标签渲染");
  assert.ok(h.includes("&lt;script&gt;") && !h.includes("<script>"), "script 转义为文本");
  // 段落语境同口径：行内 <br>/<kbd> 放行，未知/危险标签转义
  const p2 = mdToHtml("段落 <br>换行 与 <kbd>Ctrl</kbd>、<blink>x</blink>");
  assert.ok(p2.includes("段落 <br>换行"), "段内 <br> 放行");
  assert.ok(p2.includes("<kbd>Ctrl</kbd>"), "段内 kbd 放行");
  assert.ok(p2.includes("&lt;blink&gt;x&lt;/blink&gt;"), "未知标签转义可见");
});

test("表格：转义 \\| 作为字面量不分列", () => {
  const h = mdToHtml("| a | b |\n| - | - |\n| x \\| y | z |");
  const body = h.slice(h.indexOf("<tbody>"));
  assert.equal((body.match(/<td>/g) ?? []).length, 2, "应恰好 2 列：" + body);
  assert.ok(body.includes("x | y"), "转义还原为字面 |：" + body);
})

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

test("CON-02：引用块/提示块标题不占 data-sec、id 不重复；≥4 列缩进 ATX 归缩进代码（第二档），裸 # 照常占号", () => {
  const h = mdToHtml("# Top\n\n> # Quoted\n\n## Sub\n\n> [!NOTE]\n> # InCallout\n\n    # Indented\n\n#\n");
  assert.equal((h.match(/id="sec-1"/g) ?? []).length, 1, "不得有重复 id");
  assert.equal((h.match(/data-sec=/g) ?? []).length, 3, "Top/Sub/裸# 三个锚点——Indented 变缩进代码：" + h);
  assert.ok(h.includes('<code class="language-text"># Indented</code>'), "4 列缩进 ATX=缩进代码（Rust line_kinds 记 Code，Quote 行在前）");
  assert.ok(h.includes('data-sec="3"'), "裸 # 仍占号（与 headings() 一致）");
  assert.ok(h.includes('<h1 data-line-start="2" data-line-end="2">Quoted</h1>'), "引用块标题渲染但无锚点（行锚按 baseLine 记绝对行）");
  assert.ok(h.includes('<h1 data-line-start="7" data-line-end="7">InCallout</h1>'), "提示块标题同理");
  // 2 列缩进（<4 列）仍是标题——Rust headings_accept_indent_and_bare_hash_reject_quote_prefix 镜像
  const two = mdToHtml("# Top\n\n  # Indented2\n\n#\n");
  assert.equal((two.match(/data-sec=/g) ?? []).length, 3, "≤3 列缩进 ATX 照常计标题");
});

/* ══════ 滚动同步 v1.2：块锚 data-line-start/end 记账回归 ══════ */

test("块锚：标题行号与源行一致；段/围栏/表格/列表各记起止", () => {
  const h = mdToHtml("# A\n\n正文一段\n第二行\n\n```js\nconst x=1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- 甲\n- 乙");
  assert.ok(h.includes('<h1 id="sec-1" data-sec="1" data-sec-text="A" data-line-start="0" data-line-end="0">'), h);
  assert.ok(h.includes('<p data-line-start="2" data-line-end="3">'), "段落记首末行");
  assert.ok(h.includes('<div class="codeblock" data-line-start="5" data-line-end="7">'), "围栏整体含界行");
  assert.ok(h.includes('<pre data-line-start="6" data-line-end="6">'), "pre 子锚只含内容行");
  assert.ok(h.includes('<div class="tw-tbl" data-line-start="9" data-line-end="11">'), "表格起止");
  assert.ok(/<li data-line-start="13" data-line-end="13">甲<\/li>/.test(h), "li 逐项行锚（第三档起容器内连续拼接，行锚属性不依赖换行）");
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

/* ── flipTaskInSrc：Rust markdown.rs toggle_task 测试向量的逐条镜像（契约 2，2026-11-18 手动保存链路）── */

test("flip 镜像·围栏假任务不计（Rust toggle_task_ignores_fenced_fake 同料）", () => {
  const src = "- [ ] real one\n\n```text\n- [ ] fake in code\n```\n\n- [ ] real two\n";
  const out = flipTaskInSrc(src, 0);
  assert.ok(out!.includes("[x] real one"));
  assert.ok(out!.includes("- [ ] fake in code"), "围栏内不许改");
  const out2 = flipTaskInSrc(out!, 1);
  assert.ok(out2!.includes("[x] real two"));
  assert.equal(flipTaskInSrc(src, 2), null, "越界 null");
});

test("flip 镜像·有序列表与缩进保留（preserves_ordered_and_indent）", () => {
  assert.equal(flipTaskInSrc("  1. [ ] indented item\n", 0), "  1. [x] indented item\n");
});

test("flip 镜像·多字节与 CRLF 风格保留（multibyte_prefix_and_crlf）", () => {
  assert.equal(flipTaskInSrc("- [ ] 中文任务\r\n正文\r\n", 0), "- [x] 中文任务\r\n正文\r\n");
});

test("flip 镜像·无尾换行不补（no_trailing_newline_added）", () => {
  assert.equal(flipTaskInSrc("- [ ] a", 0), "- [x] a");
});

test("flip 镜像·引用块任务跳过（skips_quoted_tasks，CON-01 同根）", () => {
  const src = "> - [ ] quoted\n\n- [ ] real\n";
  const out = flipTaskInSrc(src, 0);
  assert.ok(out!.includes("> - [ ] quoted"), "引用行不许被改写");
  assert.ok(out!.includes("- [x] real"));
  assert.equal(flipTaskInSrc(src, 1), null, "全篇可勾选任务只有 1 个");
});

test("flip 镜像·]-后无空格也算任务（task_without_space_after_bracket_counts）", () => {
  assert.equal(flipTaskInSrc("- [ ]x\n", 0), "- [x]x\n");
});

test("flip 与渲染同坐标系：$$ 内任务按 Rust 口径计数、引用不计；大写 X 可反悔", () => {
  const src = "# T\n\n- [ ] 甲\n\n$$\n- [ ] math内仍计数\n$$\n\n> - [ ] 引用不计\n\n- [x] 乙\n";
  // 参与计数的顺序：0=甲、1=$$内行（Rust 不认 $$ 为围栏）、2=乙；引用行永远不计
  const one = flipTaskInSrc(src, 1);
  assert.ok(one!.includes("- [x] math内仍计数"), "math 块行按 Rust 口径计入：" + one);
  assert.ok(one!.includes("- [ ] 甲"), "甲未动");
  const two = flipTaskInSrc(src, 2);
  assert.ok(two!.includes("- [ ] 乙"), "大写 [x] 翻回未勾：" + two);
  assert.ok(two!.includes("> - [ ] 引用不计"), "引用行始终未动");
  assert.equal(flipTaskInSrc(src, 3), null, "可计数任务共 3 个");
  // 渲染侧同坐标：li 显式 2 枚 + $$ 隐藏占位 1 枚 = data-task 总数 3（taskOrdinalOf 的坐标系）
  const h = mdToHtml(src);
  assert.equal((h.match(/data-task/g) ?? []).length, 3, h.slice(0, 400));
});

test("层级编号（需求 2026-11-22）：嵌套有序列表子级继承父级序号显示", () => {
  const h = mdToHtml("1. 第一步\n2. 第二步\n   1. 大是大非\n   2. 阿迪斯发\n3. 第三步\n");
  assert.ok(h.includes(`style="--mnr:'2.1. '"`), "二级第1项显示 2.1：" + h.slice(0, 300));
  assert.ok(h.includes(`style="--mnr:'2.2. '"`), "二级第2项显示 2.2");
  const tags = (h.match(/<li[^>]*>/g) ?? []);
  assert.ok(!tags[0].includes("--mnr") && !tags[1].includes("--mnr") && !tags[4].includes("--mnr"), "顶层项不带 --mnr（原生标记零回归）");
  // 三层：1 → 1.1 → 1.1.1
  const d = mdToHtml("1. 一级\n   1. 二级\n      1. 三级\n");
  assert.ok(d.includes(`style="--mnr:'1.1. '"`) && d.includes(`style="--mnr:'1.1.1. '"`), "深层依此类推");
  // 中间无序层不占号段：1 > • > 1.1
  const m = mdToHtml("1. 甲\n   - 要点\n     1. 子\n");
  assert.ok(m.includes(`style="--mnr:'1.1. '"`), "子弹跳过编号链");
  // 子列表作者起始编号参与拼接：项2 下 `5.` → 2.5
  const s = mdToHtml("1. a\n2. b\n   5. 五\n   6. 六\n");
  assert.ok(s.includes(`style="--mnr:'2.5. '"`) && s.includes(`style="--mnr:'2.6. '"`), "start 参与层级编号");
  // 任务项作为父级同样续链
  const t = mdToHtml("1. [ ] 任务\n   1. 子\n");
  assert.ok(t.includes(`style="--mnr:'1.1. '"`), "任务父项续链");
  // 脚注汇总 ol 不受波及（无 --mnr 属性）
  const f = mdToHtml("引用[^1]\n\n[^1]: 注内容\n");
  assert.ok(f.includes("<ol") && !f.includes("--mnr"), "脚注编号保持原生：" + f.slice(f.indexOf("<ol"), f.indexOf("<ol") + 120));
});

test("段落后缩进代码块（2026-11-23 规范修正）：空行结束段落，4 列缩进回归代码块", () => {
  // 规范（CommonMark 4.4）：段落被空行关闭后，4 列缩进行构成缩进代码块；
  // 旧偏差（prev==para 跨空行不重置）曾把它按段落渲染（对比报告 P0）。
  const src = "题注\n\n    # 不是标题\n    - [ ] 不是任务\n    const x = 1;\n";
  assert.deepEqual(lineKinds(src).slice(2, 5), ["code", "code", "code"], "空行后缩进行全是代码");
  assert.equal(headingsOfSrc(src).length, 0, "块内 # 不计标题");
  assert.equal(flipTaskInSrc(src, 0), null, "块内任务不计");
  const html = mdToHtml(src);
  assert.ok(html.includes('<div class="codeblock"'), "渲染为代码块");
  // 紧邻段落（无空行）仍是懒延续：缩进代码不能打断段落（规范同口径，行为不变）
  assert.deepEqual(lineKinds("正文\n    续行\n").slice(0, 2), ["para", "para"]);
  // 列表 + 空行 + 缩进：项内容宽松口径保留（已批准偏差不扩大）
  assert.equal(lineKinds("- 项\n\n    续段\n")[2], "para");
});

test("软换行设置（2026-11-23）：默认按 GFM 折叠、开启后逐行 <br>", () => {
  const src = "第一行\n第二行\n";
  const def = mdToHtml(src);
  assert.ok(def.includes("第一行\n第二行") && !def.includes("<br>"), "默认无 <br>（折叠为空格）");
  setSoftBreakBr(true);
  try {
    assert.ok(mdToHtml(src).includes("第一行<br>第二行"), "开关开启逐行显示");
  } finally {
    setSoftBreakBr(false);
  }
  assert.ok(!mdToHtml(src).includes("<br>"), "复位后回到折叠");
});

test("徽章行不受软换行开关影响（需求 2026-11-23 定夺：无论开关都横排）", () => {
  const src = "[![A](https://a.example/a.svg)](https://a.example)\n[![B](https://b.example/b.svg)](https://b.example)\n";
  const def = mdToHtml(src);
  assert.ok(def.includes('class="imgrow"'), "默认走徽章横排行（README 惯用）");
  assert.ok(!def.includes("<br>"), "默认无 <br>");
  setSoftBreakBr(true);
  try {
    const on = mdToHtml(src);
    assert.ok(on.includes('class="imgrow"'), "开关开启仍横排（忽略开关）");
    assert.ok(!on.includes("<br>"), "图片行内不得混入 <br>");
  } finally {
    setSoftBreakBr(false);
  }
});

test("脚注回跳 ↩ 与正文同行（需求 2026-11-23）", () => {
  const h = mdToHtml("正文引用[^1]。\n\n[^1]: 这是脚注的内容。\n");
  assert.ok(h.includes('这是脚注的内容。<a class="fnback"') && h.includes("↩</a></p>"), "回跳在段内、末段 </p> 之前：" + h.slice(h.indexOf("<li id=\"fn-1\""), h.indexOf("<li id=\"fn-1\"") + 160));
  assert.ok(!/<\/p>\s*<a class="fnback"/.test(h), "不得排在段落之后（会换行）");
});
