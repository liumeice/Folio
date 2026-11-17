# Folio

> 把本地 Markdown 文件夹当成书库来阅读的 Windows 桌面应用。

Folio 是一个本地优先的 Markdown 阅读器。你可以直接打开一个文件夹，把里面的 `.md` 文档当作一本书来读；也可以切换成编辑模式修改内容，或导出为 HTML、PDF。文档保存在本地，不需要先导入云端。

当前版本：`0.2.1`

支持平台：Windows 10 1903+ / Windows 11

## 主要功能

| 功能 | 说明 |
|---|---|
| 本地书库 | 打开一个文件夹即可形成书库，左侧按目录树浏览文档 |
| 阅读优先 | 保留 Markdown 的标题层级、目录、图片、表格、代码块和引用块 |
| 阅读 / 编辑 | 阅读视图与 CodeMirror 6 编辑器切换，支持保存、自动保存提示和未保存状态 |
| 大纲导航 | 根据 `h1`–`h6` 生成大纲，点击可跳转章节 |
| 全文搜索 | 支持多文档搜索、命中高亮和结果跳转；中文检索使用 SQLite FTS5 trigram |
| Markdown 扩展 | 任务清单可直接勾选写回；支持 Mermaid、ZenUML、MathJax 和常见代码高亮 |
| 主题与排版 | 深色、浅色、护眼米色三套主题，十二种强调色，并可调整字体、行高、页宽等 |
| 多标签页 | 同时打开多篇文档，保留各文档的阅读位置 |
| 导出 | 导出 HTML 时图片随行；支持 A4 PDF 导出，并生成 PDF 大纲书签 |
| 本地存储 | 文档索引、最近打开、阅读位置和设置保存在本地 SQLite 中 |

## 快速开始

### 直接使用安装包

构建后的 Windows 安装包位于：

```text
source/target/release/bundle/nsis/Folio_0.2.1.N_x64-setup.exe
```

安装后可直接打开 `.md` 文件，或从应用内选择要作为书库的文件夹。

### 从源码运行

开发环境需要：

- Windows 10 1903+ / Windows 11
- Node.js 20+
- Rust 1.85+（MSVC 工具链）
- Visual Studio Build Tools（含 C++ 桌面开发负载）和 Windows SDK
- WebView2 Runtime（Windows 10/11 通常已自带）

在 `source` 目录执行：

```bash
cd source

npm install          # 安装前端依赖
npm run dev          # 只启动前端，浏览器中调试 UI
npx tauri dev        # 启动真正的桌面窗口
```

构建发布版：

```bash
npm run build        # TypeScript 检查 + 前端构建
npx tauri build      # 生成 exe 和安装包
```

构建产物：

```text
source/target/release/folio-app.exe
source/target/release/bundle/nsis/
source/target/release/bundle/msi/
```

## 想先看界面

`prototype/prototype.html` 是交互原型，可以直接用浏览器打开，不需要安装 Rust 或 Node.js。

原型用于确认交互和视觉，不是最终发布版；正式的 Windows 桌面程序在 `source/` 中。

## 项目结构

```text
Folio/
├─ source/                正式版工程（Tauri 2 + Rust + SolidJS）
│  ├─ crates/             Markdown、SQLite、文件读写、搜索等 Rust 模块
│  ├─ src/                前端界面、编辑器和样式
│  ├─ src-tauri/          Tauri 壳、IPC 命令、窗口与安装配置
│  └─ tests/              前端逻辑测试
├─ prototype/             交互原型与评审记录
├─ docs/                  PRD、UI 规范、设计与问题分析
├─ assets/                示例 Markdown 和测试素材
└─ README.md              本文件
```

## 技术栈

- 桌面壳：Tauri 2 + WebView2
- 前端：SolidJS + TypeScript + Vite
- 编辑器：CodeMirror 6
- 后端：Rust workspace
- 数据：SQLite + FTS5 trigram
- 文档渲染：Markdown、Mermaid、ZenUML、MathJax、highlight.js

## 测试

在 `source` 目录执行：

```bash
npm test                 # 前端逻辑测试
cargo test --workspace   # Rust 单元测试与集成测试
npm run build            # 类型检查与生产构建
```

## 相关文档

- [正式版开发说明](source/README.md)：环境、构建、版本机制和排障
- [产品需求文档](docs/Folio-PRD-v1.4-20261117.md)
- [UI 规范](docs/Folio-UI规范-v1.2-20261116.md)
- [PDF 导出问题分析](docs/PDF导出黑色边框问题分析.md)
- [架构图](docs/folio-architecture.drawio.png)

## 当前状态

- Windows 桌面版正在持续迭代，当前版本为 `0.2.1`。
- `source/` 是正式产品工程；`prototype/` 是交互参考和回归基线。
- 项目优先保证本地阅读体验、Markdown 渲染质量和长文档导航。
