# Folio 测试套件

本目录是 Folio 的自动化测试入口。设计说明见
`docs/评审与报告/Folio-单元测试用例设计-20261124.md`。

## 目录

```text
tests/
├── unit/          纯函数 / 小模块行为测试（TS）
├── contract/      跨语言共享夹具测试（TS 侧；Rust 侧在 crates/*/tests）
├── fixtures/      TS 与 Rust 共读的 JSON 契约数据
└── helpers/       测试用最小 DOM 等公共设施
```

## 运行

```bash
cd source

npm test              # 全部 TS 单元 + 契约测试
npm run test:unit     # 只看 tests/unit
npm run test:contract # 只看 tests/contract
npm run test:coverage # 全部 TS 测试 + Node 覆盖率报告
npm run check         # typecheck + 全部 TS 测试

cargo test --workspace # Rust 单元 / 集成 / 契约测试
```

## 分层

| 层 | 范围 | 位置 | 说明 |
|---|---|---|---|
| L1 单元 | Markdown 解析、插入模板、目录树、导航、排版、搜索片段等纯逻辑 | `tests/unit`、各 crate 的 `#[cfg(test)]` | 必须确定性、无网络、无真实窗口 |
| L2 契约 | TS ↔ Rust 共享输入输出 | `tests/contract`、`tests/fixtures`、`crates/*/tests` | 两侧读同一份夹具，禁止各改各的期望值 |
| L3 集成 | SQLite、文件系统、命令层 | `crates/*/tests`、`src-tauri/tests` | 允许临时目录；必须可重复运行 |
| L4 窗口冒烟 | 真实 WebView 的布局、滚动、导出 | `source/_cdp_*.mjs` | 不属于 `npm test`，按需手工跑 |

## 契约夹具纪律

1. 改动 `src/lib/md.ts` 或 `crates/folio-core/src/markdown.rs` 的标题/字数/任务口径时：
   - 先更新 `tests/fixtures/markdown-contract.json`；
   - 同时跑 `npm run test:contract` 与 `cargo test -p folio-core --test markdown_contract`。
2. 改动文件名校验时：同上，用 `filename-contract.json`，Rust 侧跑
   `cargo test -p folio-app --test filename_contract`。
3. 改动首启设置默认值时：用 `settings-default.json`，跑
   `npm run test:contract` 与 `cargo test -p folio-core --test settings_contract`。
4. 夹具中的浮点字段保留 `.0`（如 `14.0`），以便 Rust 的 `serde_json::Value`
   区分 f64 与整数；TS 侧不受影响。

## 确定性规则

- 不写固定 `sleep` 赌时间：需要 mtime 前进时轮询实际秒数（见 `src-tauri/tests/m2.rs`）。
- DOM 测试每个文件自建 JSDOM，不共享可变全局状态。
- 测试只依赖本仓库源码与 `devDependencies`，不访问网络。
- 懒加载的 Mermaid / MathJax / ZenUML 真渲染不放进单元层；单元层只测路由、错误判定、
  无目标快路径和退化契约。真渲染走 L4。

## 新增用例清单

- [ ] 这条规则是产品契约，还是实现细节？实现细节优先测可观察行为。
- [ ] 覆盖正常路、边界值、错误/退化、幂等/确定性中的至少两类。
- [ ] 涉及 TS/Rust 同口径时，是否应该进 `fixtures`？
- [ ] 失败信息能否直接指出输入与期望？
- [ ] `npm test`、`cargo test --workspace` 是否都仍为绿？