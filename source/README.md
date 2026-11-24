# Folio · source 正式版开发说明

Folio 的 Windows 桌面正式版工程，当前版本 `0.2.1`。

技术栈：Tauri 2 + Rust workspace + SolidJS + TypeScript + CodeMirror 6 + SQLite FTS5。

- 产品介绍、功能和构建入口：仓库根 `README.md`
- 交互原型：`../prototype/prototype.html`（仅本地保存，不随仓库发布）
- 产品需求和 UI 规范等 Markdown 资料仅本地保存，不随仓库提交

## 1. 环境要求

| 工具 | 要求 | 用途 |
|---|---|---|
| Windows | Windows 10 1903+ / Windows 11 | 运行和打包 |
| Rust | 1.85+，MSVC 工具链 | Rust workspace |
| Visual Studio Build Tools | 含 C++ 桌面开发负载 | 链接 Windows 原生依赖 |
| Windows SDK | 10 | Windows API 和资源编译 |
| Node.js | 20+ | 前端开发和构建 |
| WebView2 Runtime | Evergreen | 应用运行时 |
| Git Bash | 可选 | 运行 `release.sh` |

包管理器使用 `npm`。`tauri.conf.json` 中的开发和构建命令也固定为 `npm run …`，不依赖 pnpm。

## 2. 快速开始

以下命令默认在 `source/` 目录执行。

### 安装依赖

```bash
npm install
```

### 开发

```bash
npm run dev       # 只启动前端，浏览器中使用 mock 数据
npx tauri dev     # 启动真正的 Windows 桌面窗口
```

`npm run dev` 不编译 Rust，适合调 UI；涉及文件系统、SQLite、窗口、深链或导出时，使用 `npx tauri dev`。

### 测试

```bash
npm test                  # 前端单元 + 跨语言契约测试（node:test）
npm run test:coverage     # 前端测试 + 覆盖率报告
cargo check --workspace   # Rust 类型检查
cargo test --workspace    # Rust 单测 + 集成测试
npm run typecheck         # 只做 TypeScript 检查
npm run build             # TypeScript 检查 + 前端生产构建
```

单独运行某个前端测试：

```bash
node --experimental-strip-types --test tests/unit/md.test.ts
```

真实数据库副本的迁移冒烟测试（发布前可选）：

```powershell
$env:FOLIO_DB_COPY="$env:APPDATA\app.folio.desktop\folio.db"
cargo test -p folio-db -- --ignored --nocapture migrate_real_user_copy
```

该测试只操作临时副本，不会改动真实数据库。

### 构建安装包

```bash
npx tauri build
```

`tauri build` 会依次：

1. 调用 `scripts/bump-build.cjs` 发放新的编译次数；
2. 执行 `npm run build`；
3. 编译 Rust release；
4. 生成 exe、NSIS 安装包和 MSI 安装包。

首次构建可能需要联网下载 NSIS/WiX 等打包工具。

### 版本化打包

推荐使用：

```bash
./release.sh
```

`release.sh` 调用 `npx tauri build`，成功后把安装包文件名改成完整四段版本号。Windows 下请使用 Git Bash 运行。

## 3. 构建产物

| 产物 | 路径 |
|---|---|
| 可执行文件 | `target/release/folio-app.exe` |
| NSIS 安装包 | `target/release/bundle/nsis/Folio_0.2.1_x64-setup.exe` |
| MSI 安装包 | `target/release/bundle/msi/Folio_0.2.1_en-US.msi` |

`npx tauri build` 使用三段基线版本命名；运行 `./release.sh` 成功后，会重命名为 `Folio_0.2.1.N_*`，其中 `N` 是本次自动发放的编译次数。

## 4. 项目结构

```text
source/
├─ Cargo.toml              Rust workspace
├─ crates/
│  ├─ folio-core/          Markdown 解析、模型、统计和任务回写
│  ├─ folio-db/            SQLite、schema 和迁移
│  ├─ folio-fs/            文件读写、目录扫描
│  └─ folio-search/        搜索查询规划与结果片段
├─ src-tauri/
│  ├─ src/commands.rs      IPC 命令的纯逻辑
│  ├─ src/lib.rs           Tauri 命令包装、窗口、深链、导出
│  ├─ tauri.conf.json      窗口、CSP、文件关联和打包配置
│  └─ build.rs             版本资源和构建注入
├─ src/
│  ├─ components/          阅读器、编辑器、侧栏、弹层和设置
│  ├─ lib/                 状态、API、解析、导航、导出和样式逻辑
│  ├─ styles/              主题 token 和界面样式
│  └─ assets/              欢迎页等构建输入
├─ tests/                  前端单元 + 跨语言契约测试
├─ scripts/bump-build.cjs  版本发号器
└─ release.sh              版本化打包脚本
```

## 5. 架构

### 5.1 Rust

Rust workspace 包含四个业务 crate，`src-tauri` 只是桌面壳：

- `folio-core`：Markdown 解析口径的唯一权威实现，负责标题、锚点、统计、slug 和任务清单回写。
- `folio-db`：SQLite schema v4，保存文档登记、FTS 索引、阅读位置、设置、文件夹根和最近打开。
- `folio-fs`：文件读写、目录扫描、原子写和编码容错。
- `folio-search`：根据查询长度选择 FTS5 或 LIKE，并生成搜索片段。
- `src-tauri/commands.rs`：不依赖 Tauri 的命令逻辑，方便单测。
- `src-tauri/lib.rs`：命令注册、单实例、深链、PDF/HTML 导出和错误转换。

新增 IPC 命令通常要同步三处：

1. `commands.rs` 写逻辑；
2. `lib.rs` 添加 `#[tauri::command]` 并注册到 `generate_handler!`；
3. `src/lib/api.ts` 添加前端入口和浏览器 mock。

### 5.2 前端

- `src/lib/store.tsx`：产品状态，包括文档、最近打开、文件夹根、阅读位置、设置和未保存状态。
- `src/lib/ui.tsx`：瞬时界面状态，包括弹层、搜索高亮、阅读进度和右键菜单。
- `src/lib/api.ts`：Tauri IPC 与浏览器 mock 的适配层。
- `src/lib/md.ts`：Markdown 渲染器，必须与 Rust 解析器保持同一坐标系。
- `src/lib/nav.ts`：阅读、历史和编辑模式之间的位置换算。
- `src/components/EditorPane.tsx`：CodeMirror 6 编辑器，按需加载。
- `src/components/Reader.tsx`：正文渲染、大纲联动和任务勾选。

### 5.3 数据

当前数据库为 schema v4，主要表：

- `documents`：文档登记、路径、slug、统计、置顶和内置标记。
- `docs_fts`：FTS5 trigram 搜索索引。
- `positions`：每篇文档的阅读位置。
- `settings`：JSON 格式的设置。
- `roots`：当前打开的文件夹根，最多一行。
- `recents`：最近打开记录。

关键规则：

- 打开单个文件只增加最近打开记录，不加入当前文件夹目录树。
- 只有“打开文件夹”会登记文件夹及其子目录中的文档。
- 同一时间只维护一个文件夹根；再次打开文件夹是替换，不是追加。
- `documents.in_library` 只表示“是否由打开文件夹登记”，不是最近打开状态。

### 5.4 导出

- HTML 导出：生成精简 HTML，并把正文图片输出到同级 `images/` 目录。
- PDF 导出：通过 WebView2 进程内 CDP `Page.printToPDF` 生成 A4 PDF，并用 `generateDocumentOutline` 生成标题书签。
- PDF 页面底色：`actions.ts` 把阅读窗底色传给 Rust，Rust 在导出期间设置 WebView2 `DefaultBackgroundColor`，完成后还原。
- 如果修改导出逻辑，保留“等待正文稳定”和“导出互斥”两个守卫，避免长文档截断或重复导出。

## 6. 无 Rust 前端开发

`src/lib/api.ts` 会自动判断运行环境：

- Tauri 中运行：使用真实 IPC。
- 浏览器中运行：使用 localStorage mock 和内置示例文档。

mock 只用于 UI 开发，不是产品行为。mock 与 Rust 不一致时，以 Rust 为准。

## 7. 版本机制

版本号格式为：

```text
主.次.修复.编译次数
```

例如 `0.2.1.63`。

- 前三段是基线版本，需要同时存在于：
  - `src-tauri/tauri.conf.json`
  - `Cargo.toml` 的 `workspace.package.version`
  - `package.json`
- 第四段由 `scripts/bump-build.cjs` 自动发放，每次 `tauri build` 加一。
- 发号游标在 `.build`，本次完整版本在 `.build-version`。
- `.build.lock` 防止多个构建进程同时发号。
- `release.sh` 不单独发号，只负责调用构建、失败时回收本次号、重命名安装包。

## 8. 已知边界

- GBK 等非 UTF-8 编码尚未自动探测，当前以 UTF-8、BOM 剥离和 lossy 读取为主。
- 超长文档的虚拟滚动尚未引入，先按真实样本压测。
- 端到端浏览器测试尚未接入 Playwright。
- 企业离线安装的固定 WebView2 runtime 尚未内置。
- 屏幕阅读器的深度语义支持仍在后续范围。

## 9. 排障

### 打包相关

- **Tauri 找不到 pnpm**：本项目使用 npm；不要把 `beforeDevCommand` 或 `beforeBuildCommand` 改回 pnpm。
- **打包前先关闭正在运行的 `folio-app.exe`**：运行中的进程会锁住文件，导致 NSIS/MSI 打包失败。
- **手动 `cargo build --release` 不能代替 `npx tauri build`**：可能缺少 Tauri 注入，产物会回落加载开发地址。
- **MSI 报 `LGHT0311`**：进入安装器的字符串必须是 ASCII，中文描述需要 WiX 多语言配置。
- **前端改了但界面没变**：确认构建后的资源哈希和运行中的程序一致；单实例可能把新启动转发给旧进程。

### 启动与界面

- **`npm run dev` 打开空白**：确认 Vite 启动在 5173 端口。
- **启动 panic `state() called before manage()`**：检查 `tauri.conf.json` 中配置的插件是否都在 `builder.plugin(...)` 中注册。
- **窗口纯黑**：先检查 `<html data-theme>` 和 CSS 变量是否生效，再看控制台是否有组件树异常。
- **PDF 四周有黑色边框**：这是 WebView2 `DefaultBackgroundColor` 被 `printToPDF` 铺到页边距造成的，不是正文 CSS `border`。导出时保留 `bg_color` 设置和完成后还原逻辑。
- **Solid 组件黑屏但无 DevTools 报错**：检查是否使用了未初始化的 `let x!: T[]`，ref 数组应写成 `const x: T[] = []`。

### CSP 与调试

- Tauri v2 的 IPC 地址是 `http://ipc.localhost`，CSP 的 `connect-src` 必须包含它。
- Solid 运行时样式需要 `style-src 'unsafe-inline'`，不要给 style-src 注入 nonce。
- 可用下面的方式启动远程调试：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
.\target\release\folio-app.exe
```

然后用 `source/_cdp_*.mjs` 做 DOM 探针和截图。

### 网络

`cargo` 拉取依赖超时或连接重置时，可在 `~/.cargo/config.toml` 中配置镜像、`http.multiplexing = false` 和较长的超时时间。

## 10. 代码约定

- 行为变化先核对 PRD 和测试，再改实现。
- TypeScript 与 Rust 的 Markdown 解析必须同步修改。
- 修改数据库 schema 时，迁移必须可重复执行。
- 新增设置项只展示真实落地的字段。
- 新增 Tauri 命令时，同步后端、注册表和前端 API。
- 修改前端后，最终用 `npx tauri build` 验证正式产物。
