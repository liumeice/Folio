import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";

// 版本注入优先级（2026-11-16 发号改造）：
//   ① FOLIO_VERSION 环境变量（显式指定）
//   ② .build-version 文件——tauri build 的 beforeBuildCommand（scripts/bump-build.cjs）本次发放
//   ③ 「基线-dev」——纯浏览器 / vite dev（不烧号）
// 基线取自 tauri.conf.json，避免两处硬编码打架（界面不许说谎同款思路）
const confVersion: string = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).version;
const issuedVersion = (() => {
  try { return readFileSync(new URL("./.build-version", import.meta.url), "utf8").trim() || null; }
  catch { return null; }
})();
const appVersion = process.env.FOLIO_VERSION ?? issuedVersion ?? `${confVersion}-dev`;

// Tauri 期望的固定端口配置（src-tauri/tauri.conf.json devUrl 对应）
export default defineConfig({
  define: {
    __FOLIO_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: false, // P3：生产不带 .map（安装包更小、杀软扫描更轻）
    rollupOptions: {
      output: {
        // P0-2：CM6 及配套合并为单 chunk（EditorPane 已 lazy，仅首次编辑时加载）
        manualChunks: {
          codemirror: [
            "codemirror",
            "@codemirror/lang-markdown",
            "@codemirror/view",
            "@codemirror/state",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/search",
            "@codemirror/autocomplete",
            "@codemirror/lint",
          ],
        },
      },
    },
  },
});
