# Folio

> 把一堆 `.md` 当成「书」来读 —— Windows 桌面本地 Markdown 阅读器。

**当前阶段**：M1 竖切已产出安装包，M2/M3 大部与「原型 ↔ 正式版」对齐已落地（2026-11-15）——
`source/` 正式版补齐了**护眼米色主题**、**强调色色板**与**全屏设置中心**，原型左 rail 也已拆成
「文档库 + 最近打开」两个功能（此前移植了 schema v3/v4 的库/历史语义），两侧交互契约基本对齐。
2026-11-16 同日再收一轮：**原型打开文档/打开文件夹（切换·关闭库）的选择与确认全部改为仿 Windows 版式的规范内浮层对话框，不再调起任何系统原生弹窗**（UI 规范 v1.1 §8.6；真实文件走拖放）。
`prototype/` 为交互原型（三轮评审收敛，125 项冒烟断言），仍是正式版的交互契约；
`source/` 为正式版工程（Tauri 2 + Rust workspace 4 crates + 壳 + SolidJS + CodeMirror 6 + SQLite FTS5 trigram），
验证链：cargo check/test 全绿（44 项 Rust 用例通过 + 1 项迁移冒烟 `#[ignore]`）、tsc 0 错误、vite build 通过、
前端逻辑测试 8 文件（node:test：nav/libtree/codehl/md/mdstyle/typography/settings-spec/layout）。构建与排障见 [source/README.md](source/README.md)。

---

## 一分钟体验

1. 直接用浏览器打开 [prototype/prototype.html](prototype/prototype.html)（或 `python -m http.server` 后访问，行为一致）
2. 试试这些「原型里是真的」：
   - **把本地 .md 直接拖进窗口** —— 真实读取解析渲染；原型里拖入=「外部磁盘变化」，点文件夹面板 ⟳ 重新扫描后入库（正式版拖文件=仅最近打开、拖目录=扫描登记）；`Ctrl+O` 打开的是仿 Windows 版式的规范内选择对话框（原型=仿真磁盘 · 正式版=list_dir 读真实盘）
   - `Ctrl+F` 搜「大纲」→ Enter 跳转 → `F3`/`Enter` 在多处命中间循环 → `Esc` 清除
   - `Ctrl+E` 进编辑 —— 行号、Markdown 语法着色、`Esc` 放弃 / `Ctrl+S` 保存；改完切文档会明示自动保存，页签有橙点脏标记
   - 点左侧大纲跳章、`Alt+↑/↓` 翻章、`Alt+←/→` 前后退（能回到当时所在行）、`Home` 回顶
   - 「Rust 学习笔记」里**直接勾选任务清单** —— 改动写回源文本
   - 地址栏加 `#doc=rust&sec=2. 借用与引用` 刷新 —— hash 深链定位（对应正式版 `folio://` URI）
   - 三主题（深色 / 浅色 / 护眼米色）+ 六枚强调色色板，选中即时套用高亮·描边·链接·主按钮（按亮度自动配前景墨色）
   - 标题栏 ⚙ 打开设置浮窗（居中独立窗 + 轻遮罩，主界面可见）：外观·字体·段落·版面·代码与表格 五组共 11 项，改动即时写 SQLite、重启仍在；支持导入/导出配置、撤销更改、恢复默认；Esc / 点遮罩关闭
   - 「文件 → 导出为 PDF…」→ 打印预览里选「另存为 PDF」：打印版式（窗口壳隐藏、主题色忠实、分页规则）与正式版同源（`@media print`）；正式版另带静默落盘与**大纲→PDF 书签**

## 键盘快捷键

| 键位 | 功能 |
|---|---|
| `Ctrl+O` | 打开文档——规范内选择对话框（原型=仿真磁盘 · 正式版=真实盘多选）；菜单「打开文件夹…」打开/切换文件夹（即文档库）；rail 顶部亦有快捷钮；真实文件拖放整目录 |
| `Ctrl+N` | 新建文档（草稿直接编辑；首次保存弹「保存」对话框确认名字与位置） |
| `Ctrl+F` / `Ctrl+K` | 全文搜索 |
| `F3` / `Shift+F3`，跳转后 `Enter` | 搜索命中下一处 / 上一处 |
| `Ctrl+E` | 阅读 ⇄ 编辑（干净退出=直接返回，有改动=存盘并提示） |
| `Ctrl+S` | 保存编辑（阅读态按下只提示，不弹浏览器另存） |
| `Alt+↑` / `Alt+↓` | 上一章 / 下一章（先回章首再跳上章） |
| `Alt+←` / `Alt+→` | 后退 / 前进（含滚动行位置） |
| `Ctrl+W` | 关闭当前页签（v1.2 多页签；✕ / 中键同） |
| `Home` | 回到顶部（输入框聚焦时不劫持光标） |
| 分隔条 `Tab` 聚焦后 `←/→` | 调整左侧面板宽度（`Shift` 加速，`Home` 回默认，双击同） |
| `Esc` | 分层：关菜单 → 关弹层 → 清搜索高亮 → 退专注 → **编辑态=放弃修改** |
| 菜单可达 | `Tab` 进菜单栏，`←→` 切顶级菜单，`↑↓` 选项，`Enter` 执行 |

## 原型 ↔ 正式版 能力对照

| 能力 | 正式版 | 原型中的模拟 |
|---|---|---|
| 桌面壳 / 窗口 | Tauri 2.11（WebView2、单实例、`folio://`） | 浏览器标签页；窗口三键为演示态 |
| 渲染 | SolidJS 1.9 + TS 5.8 渲染管线 | 内嵌迷你 Markdown 解析器（标题/表格/任务/嵌套引用/围栏） |
| 阅读图片对齐 | **一律水平居中（2026-11-17 需求方）**：本地/远程图片、Mermaid/ZenUML/MathJax 图表全部居中；多图横行（`p.imgrow`）整行居中；导出 HTML/PDF 版式继承同一规则 | `.prose img` 同一条 auto 边距规则可演示；imgrow 横行与图表渲染原型未内置（明示正式版） |
| 编辑器 | CodeMirror 6（增量解析、折叠） | textarea 双层：透明文本 + Markdown 着色层；行号槽按行高镜像对齐软换行 |
| 存储 | SQLite（rusqlite）**schema v4**：documents(+builtin) / docs_fts(trigram) / positions / settings / roots / recents | `localStorage`：`folio-prefs`、`folio-pos-map`（每文档 `{ratio, sec, secOff}`） |
| 搜索 | FTS5，范围=**全部已登记**（库成员 + 仅在历史里的文件） | 当前文档内块级索引 + 章节分组结果 |
| 深度链接 | `folio://open?doc=<slug>&sec=<标题文本>` | 同一形态的 `location.hash` 等价物 |
| 文档库 / 最近打开 | **v4**：同时只开一个库（「打开文件夹…」= 切换）；库=该库根的目录树；历史=`recents`（不限量，按天分组）。界面文案统一称「文件夹」（2026-11-16 命名口径） | 左 rail 已拆成「文档库 + 最近打开」两功能（已移植 v3 语义）；库=目录树、历史=按天倒序 |
| 打开 / 选择 / 确认对话框 | 全部**应用内规范浮层**（`PickDialog`/`AskDialog`，2026-11-16 起不再调起系统 open/confirm；真实盘 `list_dir`、文件多选、批量上限 100）；导出/设置导入导出仍走系统对话框 | 全为**规范内浮层**（仿 Windows 通用对话框版式 + 仿真磁盘树，UI 规范 §8.6）；真实文件走拖放 |
| 主题 / 强调色 | `Settings.theme`=`dark`/`light`/`sepia`（护眼米色），`Settings.accent` 六枚色板，前端按亮度派生 `--accent-dim/-ink/-bg` 写进 body 内联 | 同一色板与派生公式（`applyAccent` 逐式一致），三主题预览卡随强调色变纹路 |
| 设置 | **居中浮窗**（`.st-panel` 轻遮罩 + `.st-win` 独立窗 1060×640；标题栏 ⚙ 或查看菜单进，Esc/点遮罩退）：5 组 11 项声明式规格（`lib/settings-spec.ts` 可单测），即时落库 + 导入/导出/撤销/恢复 | 同布局同形态（2026-11-16 原型先定稿、正式版随移植），左分组导航 + 右卡片 + 抬头「导入·导出/撤销/保存并关闭」 |
| 导出 | FR-13.1 HTML（自包含精简样式；**2026-11-17 起图片随行**：正文引用的全部图片——本地按 `data-folio-local` 留痕从磁盘复制、远程由 Rust reqwest 直下（绕开 CSP），统一落 HTML 同级 `images/` 并改写相对 src；单图失败保留原 src 兜底，Mermaid/MathJax 内联 SVG 本随正文；新命令 `export_images`）；**FR-13.2 PDF（2026-11-17）**：`文件→导出为 PDF…` 把当前阅读视图导出为 A4 PDF——主题所见即所得（含背景色）、窗口壳自动隐藏、懒图催熟；**正文标题层级（h1–h6）生成 PDF 书签树=大纲结构**（WebView2 进程内 CDP `Page.printToPDF generateDocumentOutline`，官方 PrintToPdf API 不产书签故弃）；静默落盘 + 互斥 + 失败中央提示 | 菜单同项 → 询问框 → `window.print()` 浏览器打印预览演示同一套 `@media print` 版式（书签与静默直写在框内明示为正式版能力） |

> **正式版硬提醒**：FTS5 默认 `unicode61` 不分中文词，中文检索需 trigram 或外接分词（如 jieba-rs）；Chromium textarea 滚动不计 `padding-bottom`（原型已用「外层滚动 + textarea 自适应高度」规避）。

## 仓库结构

```
prototype/                        交互原型与质量记录
  prototype.html                    当前原型
  prototype.backup.html             最初版备份（改前基线，勿动）
  prototype.snapshot-*.html         每轮改动前的时间戳快照（见「迭代约定」）
  prototype-review-codex.md         第一轮评审（codex）
  改进建议v1.md / 改进建议v2.md      第二、三轮评审
  _smoke/                           jsdom 冒烟测试（125 项断言）
    smoke.js
source/                           正式版工程（开发中）
  Cargo.toml                        Rust workspace：folio-core / db / fs / search + src-tauri
  crates/                           各 crate（解析口径、SQLite FTS5-trigram、文件 IO、查询规划）
  src-tauri/                        Tauri 2 壳：命令层、单实例、folio:// 深链、文件关联
  src/                              SolidJS + TS 前端（CM6 编辑器、组件与样式移植）
  index.html / vite.config.ts …
README.md                         本文件
```

### 运行原型测试

```bash
cd prototype/_smoke && npm install   # 仅首次（依赖 jsdom）
node smoke.js ../prototype.html
```

覆盖：快捷键穿透守卫、dirty/自动保存/丢弃、每文档进度恢复、演示条目统计口径、
搜索分组与命中循环、复选框回写、图片放大、菜单键盘导航、库筛选、hash 深链、
排版持久化、编辑器布局守卫等。注意 **jsdom 无布局引擎**：纯视觉/滚动几何问题需真实浏览器复核
（历史上双滚动条、textarea 窄条、末行贴底三个 bug 均为浏览器实测发现）。

## 质量记录与已知问题

- **改进建议 v1**（26 条）：已处置完毕 —— P0 全修，新发现项全部落地，取舍项（真多页签、
  纵向 chrome 精简、圆点色彩语义等）在评审文档中有标注。
- **改进建议 v2**（N1–N21，基线 22:16 版）：已处置 ——
  N1 toast 队列制（自动保存提示不再被顶掉）、N2 短文档不再误判末章、
  N3 复选框回写与渲染器同坐标系（代码围栏内假任务不计数）、N4 导航前同步冲刷挂起位置、
  N5 菜单键盘光标与残留高亮随关闭复位、N6/N7 `Ctrl+Q`/筛选框内 `Ctrl+S` 全焦下拦截、
  N8 命中浮动条出现时 toast 上移让位、N9 启动恢复改存 `folio-last-doc`、
  N10 专注模式 toast 文案如实、N11 导入文档持久化（稳定 ID 去重，超配额退化会话级）、
  N12 菜单键盘处理器忽略修饰键组合、N13 窄窗降级改为「chip→页签→菜单溢出」，窗口三键永不收、
  N14 未保存提示收敛为两处、N15 编辑栏实现说明移入 tooltip、N16 浅色线条/滚动条加深、
  N18 `hashchange` 运行中实时定位、N20 演示条目拒绝复制不存在的深链。
  记录不修的：N17（分组头重复=为跨库预演，评审认可）、N19（字数含代码块=「以源文本为唯一口径」
  的有意选择）、N21（失焦光标行指示，正式版 CM6 自带）。
- v2 基线后另行修复的布局回归：编辑器被压成窄条、末行贴底无留白（见快照序列）。
- 已知原型局限：`Ctrl+Q` 等少数系统级组合键浏览器可能仍优先拦截（正式版由 Tauri 全局注册）；
  导入文档持久化受 localStorage 配额限制。

## 迭代约定（本项目）

1. **改原型前先做带时间戳的快照**（在 `prototype/` 内：`cp prototype.html prototype.snapshot-MMDD-HHmm-主题.html`），
   历史快照与原始备份不覆盖、不删除。
2. **契约原则**：文档（指南页、菜单、快捷键表）里写的每一句话都必须在原型里演示得出来；
   演示不出来的不写，或明示「正式版」。
3. 每轮改动后跑 `prototype/_smoke` 全量断言；视觉/布局改动必须真实浏览器复核。
4. 双主题灰阶以 WCAG AA（小字 ≥4.5:1）为验收线，改动 token 后用同一公式回归验算。

---

*Folio · v0.1 prototype · 2026-11 · 单文件原型，无构建步骤，离线可用（CDN 字体失败时回退系统字体）*
