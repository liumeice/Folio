# Folio · source —— 正式版工程

Tauri 2 + Rust workspace + SolidJS 1.9 + CodeMirror 6 + SQLite FTS5。
交互契约与验收基线见仓库根 `README.md`、`docs/Folio-PRD-v1.2-20261114.md` 与 `docs/设计变更-文档库与最近打开-20261114.md`（后者修订 PRD v1.2 的 FR-10）。

## 环境要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Rust | ≥1.85（msvc host） | workspace 编译 |
| Visual Studio Build Tools（或 VS 2022/2026 + VC++ 负载）+ Windows SDK 10 | — | 链接 windows 系 crate |
| WebView2 Runtime | Evergreen | 运行时（Win10 1903+/11 自带） |
| Node.js | ≥20（本机 24 验证） | 前端构建 |
| pnpm | 10（推荐）/ npm 亦可 | 见下方说明 |

> **包管理器说明**：`tauri.conf.json` 的 beforeDev/BuildCommand 配置为 `npm run …`，以保证无 pnpm 权限的环境开箱即用；
> 建议环境请用 `pnpm@10`（`corepack enable` 需管理员）。两种安装方式产物一致。

## 快速开始

```bash
npm install            # 或 pnpm install
npm run dev            # 纯前端 + 浏览器 mock（无需 Rust，UI 可开发验证）
cargo test --workspace # Rust 单测 + M2 集成测试
# 前端逻辑测试（Windows 下需显式点名文件，不支持目录 glob）：
node --experimental-strip-types --test tests/codehl.test.ts tests/nav.test.ts
node --experimental-strip-types --test tests/libtree.test.ts   # 文档库目录树（v3）
# 真实库副本的迁移冒烟（发布前跑一次，只动临时副本）：
FOLIO_DB_COPY="$APPDATA/app.folio.desktop/folio.db" cargo test -p folio-db -- --ignored --nocapture migrate_real_user_copy
npm run build          # tsc --noEmit + vite build → dist/
npx tauri dev          # 真桌面窗口（Rust 全家桶首次编译较久）
npx tauri build        # 产出 release exe + NSIS 安装包（需联网下载 NSIS/WiX）
./release.sh           # 版本化出包（推荐）：v主.次.修复.编译次数，见下「版本机制」
```

## 版本机制（v0.2.0.N）

版本号形如 **`主.次.修复.编译次数`**（当前 `0.2.0.5`）：

- **基线 `主.次.修复`**：手动维护在 `src-tauri/tauri.conf.json` 的 `version`（与 Cargo workspace.package / package.json 三处一致）；Tauri schema 强制三段 semver，`npx tauri build --config version=四段` 会被拒。
- **第四段 `N`（2026-11-16 改造：自动发号）**：发号挂在 `tauri.conf.json` 的 `beforeBuildCommand`（`scripts/bump-build.cjs`）——**任何 `tauri build` 入口（release.sh / 直接 npx / 任意 agent 实例）每构建自动 +1**，游标 `source/.build`、当次版本 `source/.build-version`，`.build.lock` 目录锁跨进程互斥（不撞号、不倒退；历史锚点 0.2.0.4，游标落后于锚点时按锚点续发）。`release.sh` 不再自行发号，只在失败时回退本次号（游标确系本次推进才退）。
- **四段号落点**：① PE `FileVersion/ProductVersion/FileVersionRaw`——`build.rs` 在 `tauri_build` 生成 `OUT_DIR/resource.rc` 后就地改四行版本号、用 `rc.exe` 原地重编 `resource.lib`（不能另挂 winres 资源：与 tauri 的 VERSION 块重复 → CVTRES/LNK1123）；② 应用内标题栏 chip——`FOLIO_VERSION` env → vite `define __FOLIO_VERSION__` → `src/lib/version.ts`（dev/mock 回落 `0.2.0-dev 开发版`）；③ 安装包文件名——构建成功后复制 `Folio_0.2.0.N_x64-setup.exe / _en-US.msi` 副本（MSI 内 ProductVersion 字段受 Windows Installer 规范限制只收三段，属平台约束）。
- **版本来源优先级**（build.rs 与 vite 一致）：`FOLIO_VERSION` env → `source/.build-version`（发号器本次发放）→ 无（`cargo check / tauri dev` 跳过注入，行为如旧）。

产物：
- `target/release/folio-app.exe`
- `src-tauri/target/release/bundle/nsis/Folio_0.1.0_x64-setup.exe`

## 结构

```
Cargo.toml            workspace：folio-core / db / fs / search + src-tauri
crates/folio-core     领域模型、Markdown 解析口径（标题/统计/slug/任务回写——唯一权威实现）
crates/folio-db       SQLite：**schema v4** documents(+builtin) + docs_fts(trigram) + positions + settings + **roots(最多一行)** + recents，user_version 迁移
crates/folio-fs       文件读写（原子写、BOM/lossy）、目录扫描
crates/folio-search   查询规划（≥3 字符 FTS5 / 短查询 LIKE 兜底）、片段与分组
src-tauri/            **24 个 IPC 命令**（以 lib.rs `generate_handler!` 注册表为准；v3 换面：新增 list_recents / remove_recent / clear_recents / set_in_library，
                      移除歧义的 remove_doc / clear_recent）、单实例、folio:// 深链、文件关联、welcome 首启、opener 外链
src/                  SolidJS 前端（store/ui 双信号层，CM6 编辑器，原型 token 体系样式移植）
tests/*.test.ts       node --experimental-strip-types --test（nav 历史恢复语义 / libtree 库树 / codehl 着色 / md 解析）
```

## 前端无 Rust 开发模式

`src/lib/api.ts` 自动检测运行环境：Tauri 走 IPC；纯浏览器（`npm run dev`）回退到
localStorage mock + 内置演示文档，用于 UI 迭代。回退层不是产品特性，正式版一律以 Rust 为准。
回退层同样实现了 v3 的两套清单语义（库成员按库根推导 + `folio-browser-mock:recents` 打开历史），
浏览器里看到的库/历史关系应与真机一致；`demo/` 下两份演示文档视作"一次目录扫描的产物"，否则库面板恒空。

## 已知边界

已完成（2026-11-14）：M1 竖切 + M2/M3 大部 + **多页签（PRD v1.2：开签/切换/✕·中键·Ctrl+W 关闭/邻位承接/空态回归）**——置顶/从库移除/右键菜单、schema v2（pinned/roots 迁移测试绿）、
多库根登记与移除、扫描 mtime 增量（unchanged 计数）、外部保存冲突二选一（CONFLICT + 覆盖/重载）、
草稿找回（folio:draft:*）、导出 HTML（自包含样式、save 对话框）、SCAN_LIMIT 设置化（后端已读 settings.scanLimit）。
另完成：**阅读⇄编辑滚动同步**（章节+比例双坐标系：进/退编辑互载位置、编辑态大纲点击跳源码行、编辑器滚动大纲/§实时跟随，nav.ts 纯函数+5 项往返断言）；阅读区代码块语法着色（highlight.js 按需注册 25 语言：js/ts/html/css/json/py/rs/go/java/c/c++/c#/php/rb/kt/swift/lua/sh/sql/yaml/toml/docker/make/diff/text；
别名归一化；未知语言保持素文本不猜测；配色映射主题 token 双主题自适应；jsdom 断言 4 项入 tests/）。
**本轮（2026-11-14）· schema v3：文档库与「最近打开」解耦**——库成员的唯一来源是「打开文件夹…」扫描
（打开单个文件只进历史，不再"打开即入库"）；新增 `recents` 表与 `builtin` 列，迁移把旧 `settings.libraryRoot`
并进 `roots`（否则本机 145 篇会被整批判为出库）；侧栏新增「最近打开」面板、文档库面板改目录树、
搜索标签「全库」→「全部」。决策、迁移规则与实测口径见 `../docs/设计变更-文档库与最近打开-20261114.md`。
原型侧已移植这一契约（左 rail 拆成「文档库 + 最近打开」两功能，库=目录树、历史=按天倒序），根 README 的能力对照表已据此更新。
**同日三次修订 · 编辑区着色对齐原型 + 左右栏可拖宽**——`src/lib/mdstyle.ts`（Markdown tag→主题 token 着色表）+ `src/lib/mdStructural.ts`（围栏行/引用行/列表符号的语法装饰，lezer tag 分不开的那三类），此前编辑器只挂着 CodeMirror 通用浅色配色（标题带下划线、列表刷绿、语言名深蓝），与原型不是一套；新增 `Splitter` 分隔条（拖动改宽、双击回默认、←/→ 步进、宽度落 settings.sideWidth、窗口缩窄自动重新夹紧），约束纯函数在 `src/lib/layout.ts`。核对：`tests/mdstyle.test.ts`（tag 覆盖度）+ `tests/layout.test.ts`（夹紧）。
**同日二次修订 · schema v4：单库策略**——`roots` 同时最多一行；「打开文件夹…」= 切换库：先选目录、再确认「关闭旧库 N 篇出库 / 打开新库」，取消等于什么都没做。v4 迁移把历史遗留的并存库根一次性清空（不猜该留哪个），登记行、索引、进度、历史一项不删。`ScanReport` 随之新增 `prevRoot` / `prevDemoted`。详见设计文档 §7.5。
**同日三次修订 · 排版设置抽屉**（后被下述全屏设置中心取代，换算层保留）：标题栏滑杆按钮打开右侧 300px 抽屉（取代原 FontPopover 小浮层），控件为字级/行高/字距/段距/对齐/行宽/代码块字号/表格密度 + 实时样张 + 恢复默认；区间与「设置→CSS 变量」换算集中在 `src/lib/typography.ts`，`tests/typography.test.ts` 7 项盯范围、换算、CSS 变量是否真被引用、以及 TS 两份默认值与 Rust `Settings::default` 三方一致。
**2026-11-15 · 全屏设置中心 + 主题/强调色落地**（次日形态改版，见下）：300px 抽屉升级为**全屏设置视图**（`.st-panel`，与 side/center 同层 flex 子项，`settings-open` 时隐藏 side/center/splitter、rail 与标题栏保留，保持挂载不丢编辑器状态；rail ⚙ 进、Esc 退）。
**2026-11-16 · 设置浮窗化 + 入口迁标题栏**（原型先定稿：浮窗 + 加宽 + ⚙ 迁移 + 撤 rail 钮，冒烟 102/102；随后移植）：`.st-panel` 改为**全屏轻遮罩**（fixed、z-index 170 压 `.ctxmenu`(160) 让位 `#dropveil`(180)，rgba(9,14,24,.42) + 2px 模糊），内层新增 `.st-win` **居中独立浮窗**（`min(1060px,94vw)×min(640px,88vh)`、圆角 12px、投影、`st-pop` 0.18s 弹入；1060 为实测定值，920 会让设置行换行）；**删除** `.body.settings-open` 隐藏 side/center/splitter 的规则——主界面保持可见且挂载，状态栏不再被藏。设置入口=**标题栏 ⚙**（专注模式右边，`TitleBar.tsx`），rail 底部 ⚙ 连同 spacer/监听/选中态同步从 `SidePanels.tsx` 清除。关闭：Esc（ui.tsx 既有分层）/ 点遮罩空白（`SettingsPanel` 根节点 onClick 判 `e.target===e.currentTarget`）/ 再点 ⚙ / 保存并关闭。面板内部＝左分组导航（216px）+ 外观（三张主题预览卡 + 6 枚强调色色板）+ 各分组卡片行 + 抬头「导入·导出（图标钮）/ 撤销更改 / 保存并关闭（主按钮）」+ 底部「恢复默认」；控件规格声明式集中在 `src/lib/settings-spec.ts`（5 组 11 项，可单测 `tests/settings-spec.test.ts`），`SettingsPanel.tsx` 不含数据判断（「界面不许说谎」：未在后端落地的项不摆空控件）。后端 `Settings.theme` 增 `"sepia"`（护眼米色，令牌 `app.css [data-theme="sepia"]`）、`Settings.accent`（前端 `src/lib/accent.ts` 按相对亮度派生 `--accent-dim/-ink/-bg` 写进 **body** 内联，压在 `[data-theme]` 主题块之上；空串=跟随主题内置色）。settings 以 JSON blob 存、结构级 `#[serde(default)]`，加字段无需 schema 迁移；导入/导出配置走 `save/open` 对话框 + `write_file`/`read_file`。标题栏按钮集同步对齐原型（撤 ☾ 主题钮与 ⚙ 排版钮：主题切换归「查看→深色/浅色主题」菜单项，设置入口归 rail 底部 ⚙，「关于」改由「帮助→关于 Folio」进）。
仍欠：首屏 bundle 拆分（M5，hljs+CM6 一并懒加载分块）、扫描上限 UI 入口、NSIS 企业离线（fixed runtime）、Playwright e2e、
屏幕阅读器深度支持（P2）、PDF 导出（1.x）。OS 级全局快捷键不引入（PRD D5 决议）。

## 排障

- **tauri build 报 `pnpm` 找不到**：本仓库配置已用 `npm run`；若你改回 pnpm，请先 `corepack enable`（管理员）或全局装 pnpm。
- **cargo 下载 crates 超时/重置**：国内网络在 `~/.cargo/config.toml` 配 sparse 镜像 + `http.multiplexing=false`（本机已配 TUNA）。
- **窗口打开空白**：dev 模式确认 `npm run dev` 起在 5173（strictPort）。
- **MSI 打包 LGHT0311（codepage 1252）**：`tauri.conf.json` 中会进入安装器的字符串（fileAssociations.description 等）必须纯 ASCII；中文需配 wix 多语言。targets=all 时 MSI 失败会连坐 NSIS 不产出。
- **启动 panic `state() called before manage()`**：tauri.conf 的 `plugins.*` 配置不会自动注册 Rust 插件，`builder.plugin(xxx::init())` 一个都不能少（cargo check 发现不了这类漏注册）。
- **窗口纯黑什么都没有**：主题 token 选择器与宿主类名不匹配（自原型移植时丢了 `class="app"`）。已改为与类名无关的 `[data-theme=…]` 挂在 `<html>`；若再见黑屏，先 F12/控制台看 `getComputedStyle(document.body).getPropertyValue('--text')` 是否为空。
- **黑屏但 DevTools 无报错**：可能是 Solid `let x!: T[]` 运行时未初始化（ref 回调写入 `undefined[0]` 炸掉组件树）——`let bs!: HTMLElement[]` 教训，改 `const bs: HTMLElement[] = []`。
- **CSP 拦 IPC / 样式**：Windows 上 Tauri v2 的 IPC 走 `http://ipc.localhost`，手写 CSP 必须含 `connect-src 'self' ipc: http://ipc.localhost`；Solid 写 inline style 需保持 `style-src 'unsafe-inline'` 且**不给 style-src 注入 nonce**（`dangerousDisableAssetCspModification: ["style-src"]`），否则 `'unsafe-inline'` 按规范被忽略。
- **黑屏/错误页取证术（不用肉眼盯桌面）**：`set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 启动 exe → `node _cdp_probe.mjs`（DOM 状态探针 + 控制台异常收集 + `_webview_shot.png` 截图直读）。
- **手动 `cargo build --release` ≠ `tauri build`**：缺 tauri CLI 环境变量时产物可能回落加载 devUrl（表现为"localhost 拒绝连接"错误页）。改前端后一律 `npx tauri build`。
