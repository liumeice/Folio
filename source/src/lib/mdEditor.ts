/* 编辑区的 Markdown 解析器配置。单独成模块只为一个目的：
 * 让 tests/unit/mdstyle.test.ts 能用**同一个**入口断言 GFM 构造真的被解析出来。
 *
 * 坑在这里：`markdown()` 的默认 base 是 commonmarkLanguage，
 * 而 CommonMark 不认 ~~删除线~~ / - [x] 任务清单 / 表格 —— 于是这三类构造在编辑区
 * 根本没有 token，着色表写得再对也不会出现颜色。阅读区（lib/md.ts）是解析这些的，
 * 两侧口径必须一致，所以这里显式传 markdownLanguage（GFM + 上下标 + emoji）。
 * 实机比对（_cdp_hltable.mjs）抓到的就是这个差异。 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

export const md = () => markdown({ base: markdownLanguage });
