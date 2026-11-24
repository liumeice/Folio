# i18n 目录规范

多语言支持的消息目录与运行时。设计文档：`docs/设计方案/设计文档-多语言支持-20261124.md`。
文案对照：`docs/设计方案/Folio-多语言文案对照表-v2.0-20261124.md`。

## Key 规则

- 扁平 key，英文点分层级：`<domain>.<area>.<item>[.<state>]`，全小写。
- 一个 key 一整句；不要把句子拆成片段再拼接（实施时先合并，见对照表评审 §5.1）。
- 占位符统一 `{name}`（字母/数字/下划线）；两种语言的占位符集合必须一致。
- 复数用 `.one` / `.other`（必要时 `zero` / `few` / `many`），由 `tp(base, count)` 选择；中文两者可同文。
- 例外：文件名校验 reason 用大写码（`filename.error.EXISTS`），与 Rust 的 `Invalid("EXISTS")` 一一对应。
- Emoji 场景 key 由短代码派生（`editor.emoji.scene.white_check_mark`），不要用中文或表情本身。
- 标注块菜单与阅读区渲染共用 `markdown.callout.*`，避免两套术语。

## 文件

- `catalog/zh-CN.ts`：源语言目录，`MessageKey` 类型来源。中文原样搬迁，不改写措辞（视觉回归零 diff）。
- `catalog/en-US.ts`：`Record<MessageKey, string>`；英文 UI 内不得残留中文（`toast.language.zh` 等语言名白名单除外）。
- `index.ts`：`resolveLocale` / `locale` 信号 / `t()` / `tp()` / `setLocale()` / `rememberPref()`。
- `format.ts`：`Intl` 数字、百分比、日期、相对日、文件大小。
- 启动首帧：`source/public/boot-locale.js`（读 `localStorage["folio:localePref"]`，在 `main.tsx` 之前执行）。

## 校验

- `npm run check:i18n`：AST 扫描 `source/src/**/*.{ts,tsx}` 的字符串/JSX 文本/模板串，报告残留中文（排除 `catalog/zh-CN.ts`、注释、技术名词与语言名白名单）。
- `tests/unit/i18n.test.ts`：key 对齐、占位符一致、复数存在、英文无中文残留、`resolveLocale` 解析矩阵。