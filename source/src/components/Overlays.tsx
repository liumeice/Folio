/* 快捷键一览 / 关于 / 文档信息 / 排版弹层 / 命中浮动条 / 图片放大 / 拖放遮罩 */
import { For, Show } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { escapeHtml } from "../lib/md";
import { api, isTauri } from "../lib/api";
import { revealInFolder, confirmBox, pickFolderAndScan } from "../lib/actions";
import { APP_VERSION, IS_DEV } from "../lib/version";
import type { CtxTarget } from "../lib/ui";

const KEYMAP: [string, string][] = [
  ["Ctrl O", "打开本地 .md（可多选）"],
  ["Ctrl N", "新建文档（草稿即写，首次保存确认名字与位置）"],
  ["Ctrl F / Ctrl K", "全文搜索"],
  ["F3 / Shift+F3", "搜索命中下一处 / 上一处"],
  ["Ctrl E", "阅读 ⇄ 编辑（有改动时保存并提示）"],
  ["Ctrl S", "保存编辑（阅读态按下仅提示）"],
  ["Alt ↑ / Alt ↓", "上一章 / 下一章"],
  ["Alt ← / Alt →", "后退 / 前进（同文档回当时行）"],
  ["Home", "回到顶部（输入焦点内不劫持光标）"],
  ["Esc", "关弹层 → 清高亮 → 退专注 → 编辑中放弃修改"],
  ["Ctrl Q", "退出（有未保存内容需确认）"],
];

function OverlayShell(props: { id: string; open: boolean; onClose: () => void; mid?: boolean; children: any }) {
  return (
    <div id={props.id} class="overlay" classList={{ mid: !!props.mid, open: props.open }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      {props.children}
    </div>
  );
}

export function KeysModal() {
  return (
    <OverlayShell id="keys-overlay" mid open={ui.keysOpen()} onClose={() => ui.setKeysOpen(false)}>
      <div class="modal">
        <div class="modal-h">
          <span class="mi2"><svg class="ico ico-18"><use href="#i-md" /></svg></span>
          <div><div class="mt">快捷键一览</div><div class="md2">编辑态内快捷键已隔离，不会穿透</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setKeysOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <For each={KEYMAP}>{([k, d]) => (
            <div class="krow"><kbd>{k}</kbd><span class="sp" /><span>{d}</span></div>
          )}</For>
        </div>
        <div class="modal-f">
          <span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>应用内加速键 · 窗口聚焦态生效</span>
          <span class="sp" />
          <button class="btn" onClick={() => ui.setKeysOpen(false)}>知道了</button>
        </div>
      </div>
    </OverlayShell>
  );
}

export function AboutModal() {
  const s = useStore();
  const tags: [string, boolean][] = [   // 首个 accent 底、其余描边——逐条对齐原型 §8.2
    ["Tauri 2.11", false], ["Rust workspace", true], ["SolidJS 1.9", true],
    ["TypeScript 5.8", true], ["CodeMirror 6", true], ["SQLite + FTS5", true], ["Vite 6", true],
  ];
  /* 打开仓库主页：Tauri 下走 opener 插件交系统默认浏览器（同 Reader.openExternal 范式，
   * WebView2 里 target=_blank 不会自己出去，必须 preventDefault + openUrl） */
  const REPO_URL = "https://github.com/liumeice/Folio";
  async function openRepo() {
    if (isTauri) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(REPO_URL);
      } catch {
        s.toast("打开外链失败");
      }
    } else {
      window.open(REPO_URL, "_blank", "noopener");
    }
  }
  return (
    <OverlayShell id="about-overlay" mid open={ui.aboutOpen()} onClose={() => ui.setAboutOpen(false)}>
      <div class="modal" style={{ width: "440px" }}>
        <div class="modal-h">
          <span class="mark" style={{ width: "32px", height: "32px", "border-radius": "9px", "font-size": "15px" }}>F</span>
          <div><div class="mt">Folio <span style={{ "font-size": "11px", color: "var(--text-3)", "font-weight": "400" }}>v{APP_VERSION} · {IS_DEV ? "开发版" : "正式版"}</span></div>
            <div class="md2">把一堆 .md 当成「书」来读</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setAboutOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <div style={{ "font-size": "12.5px", color: "var(--text-2)", "line-height": "1.8", "margin-bottom": "14px" }}>
            Windows 桌面本地 Markdown 阅读器。阅读状态存于本地 SQLite，数据不上传；文档中的网络图片按需在线加载。
          </div>
          <div class="about-stack">
            <For each={tags}>{([t, plain]) => <span class={plain ? "tag plain" : "tag"}>{t}</span>}</For>
          </div>
          <div style={{ "margin-top": "16px", padding: "10px 12px", border: "1px solid var(--line)", "border-radius": "var(--r-2)", "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--text-3)" }}>
            GitHub：<a class="about-repo" href={REPO_URL} target="_blank" rel="noopener"
              onClick={(e) => { e.preventDefault(); openRepo(); }}>github.com/liumeice/Folio</a><br />
            深度链接：<span style={{ color: "var(--accent)" }}>folio://open?doc=&lt;slug&gt;&amp;sec=…</span><br />
            {isTauri ? "单实例 · WebView2 · " + s.docs().length + " 篇已索引" : "浏览器演示环境（Rust 未接入，localStorage 模拟）"}
          </div>
        </div>
        <div class="modal-f"><span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>数据只落本地 · 网络图片在线加载</span><span class="sp" />
          <button class="btn primary" onClick={() => ui.setAboutOpen(false)}>好</button></div>
      </div>
    </OverlayShell>
  );
}

/* 复制成功浮层：中央小卡 2s 自动消失（ui.showCopied 驱动） */
export function CopyPop() {
  return (
    <Show when={ui.copyPop()} keyed>{(p) => (
      <div class="copypop on">
        <svg class="ico ico-14"><use href="#i-check-circle" /></svg>
        <span>{p.msg}</span>
        <Show when={p.link}><code>{p.link}</code></Show>
      </div>
    )}</Show>
  );
}

export function PropsModal() {
  const s = useStore();
  const cur = () => s.current();
  function link(): string {
    const c = cur();
    if (!c) return "—";
    const sec = s.activeSec();
    const o = sec != null ? c.outline[sec - 1] : undefined;
    // 可读原文（§10.9 v1.1）：中文标题/slug 不 percent 编码
    return "folio://open?doc=" + c.meta.slug + (o ? "&sec=" + o.text : "");
  }
  const rows = (): [string, string][] => {
    const c = cur();
    if (!c) return [["状态", "未打开文档"]];
    return [
      ["路径", c.meta.path],
      ["大小", (c.meta.size / 1024).toFixed(1) + " KB"],
      ["字数", c.meta.wordCount.toLocaleString() + " 字（源文本口径）"],
      ["小节 / 标题", c.meta.secCount + " 节 / " + c.outline.length + " 条"],
      ["编码", "UTF-8"],
      ["修改时间", new Date(c.meta.mtime * 1000).toLocaleString()],
      ["当前章节", s.activeSec() != null ? (c.outline[s.activeSec()! - 1]?.text ?? "—") : "—"],
      ["阅读进度", Math.round(ui.readPct() * 100) + "%"],
      ["深度链接", link()],
    ];
  };
  return (
    <OverlayShell id="info-overlay" mid open={ui.propsOpen()} onClose={() => ui.setPropsOpen(false)}>
      <div class="modal" style={{ width: "480px" }}>
        <div class="modal-h">
          <span class="mi2"><svg class="ico ico-18"><use href="#i-info" /></svg></span>
          <div style={{ "min-width": "0" }}><div class="mt">文档信息</div><div class="md2 ellip">{cur()?.meta.fileName ?? "—"}</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setPropsOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <For each={rows()}>{([k, v]) => (
            <div class="krow"><span style={{ color: "var(--text-3)" }}>{k}</span><span class="sp" />
              <span style={{ "font-family": "var(--font-mono)", "font-size": "11.5px", "word-break": "break-all", "text-align": "right" }}>{v}</span></div>
          )}</For>
        </div>
        {/* §8.2 按钮组口径：等宽、dismiss（关闭）居左 */}
        <div class="modal-f"><span class="sp" /><span class="mfb">
          <button class="btn" onClick={() => ui.setPropsOpen(false)}>关闭</button>
          <button class="btn primary" onClick={() => {
            navigator.clipboard?.writeText(link()).then(() => ui.showCopied("已复制深度链接", link()))
              .catch(() => s.toast("剪贴板不可用"));
          }}><svg class="ico ico-14"><use href="#i-copy" /></svg>复制深度链接</button>
        </span></div>
      </div>
    </OverlayShell>
  );
}

export function ImgBox() {
  return (
    <div class="overlay mid" classList={{ open: ui.imgSrc() != null }} id="imgbox"
      onMouseDown={() => ui.setImgSrc(null)}>
      <div style={{ "pointer-events": "none", "text-align": "center" }}>
        <Show when={ui.imgSrc()}>
          <img src={ui.imgSrc()!} alt="" style={{ "max-width": "90vw", "max-height": "78vh", "box-shadow": "var(--shadow-pop)" }} />
        </Show>
        <div style={{ "margin-top": "10px", "font-size": "11.5px", color: "var(--text-3)" }}>点击任意处关闭 · Esc</div>
      </div>
    </div>
  );
}

/* 排版设置已从浮层 FontPopover 迁到右侧抽屉 components/TypeDrawer.tsx（控件多了，浮层挤不下）。 */

export function HitNav() {
  return (
    <Show when={ui.hitNavVisible()}>
      <div class="hitnav">
        <button type="button" title="上一处 (Shift+Enter)" onClick={() => ui.stepHit(-1)}>
          <svg class="ico ico-14"><use href="#i-chev-u" /></svg>
        </button>
        <span>命中 <b>{ui.hitIdx() + 1} / {ui.hitCount()}</b></span>
        <button type="button" title="下一处 (Enter / F3)" onClick={() => ui.stepHit(1)}>
          <svg class="ico ico-14"><use href="#i-chev-d" /></svg>
        </button>
        <span><kbd>Enter</kbd> 下一处 · <kbd>Esc</kbd> 清除</span>
      </div>
    </Show>
  );
}

export function ContextMenu() {
  const s = useStore();
  async function run(tt: CtxTarget & { kind: "doc" }, item: string) {
    const m = tt.meta;
    ui.setCtxMenu(null);
    // UI-15/统一口径：菜单动作失败一律顶部提示，不再无声吞掉
    try {
      if (item === "pin") { await api.setPinned(m.id, !m.pinned); s.toast(m.pinned ? "已取消置顶" : "已置顶"); }
      // 从文档库移除 = 取消库成员身份：登记/进度/打开历史都留着，重扫该目录会再入库
      else if (item === "unlibrary") {
        await api.setInLibrary(m.id, false);
        s.toast("已从文件夹移除（进度与历史保留 · 重新打开该文件夹会再列入）");
      }
      // 从最近打开移除 = 删打开记录；若这文件从没入过库，登记连带回收
      else if (item === "unrecent") {
        const purged = await api.removeRecent(m.id);
        s.toast(purged ? "已从最近打开移除（该文档不在库，登记一并回收）" : "已从最近打开移除");
      }
      else if (item === "reveal") { void revealInFolder(m.path, s); return; }
      else if (item === "path") { void copyText(m.path); return; }
      else if (item === "link") {
        const l = "folio://open?doc=" + m.slug;
        navigator.clipboard?.writeText(l).then(() => ui.showCopied("已复制深度链接", l))
          .catch(() => s.toast("剪贴板不可用"));
        return;
      }
      void s.refreshDocs();
    } catch (e) {
      s.toast("操作失败：" + String(e));   // UI-15：菜单动作失败必须有声
    }
  }
  function copyText(text: string) {
    navigator.clipboard?.writeText(text)
      .then(() => s.toast("已复制：" + (text.length > 40 ? text.slice(0, 40) + "…" : text)))
      .catch(() => s.toast("剪贴板不可用"));
  }
  const item = (label: string, key: string, tt: CtxTarget & { kind: "doc" }, icon = "i-md") => (
    <div class="mi" onClick={() => run(tt, key)}>
      <svg class="ico ico-14"><use href={"#" + icon} /></svg><span class="t">{label}</span>
    </div>
  );
  return (
    <Show when={ui.ctxMenu()} keyed>{(tt) => (
      <div class="ctxmenu" style={{ left: tt.x + "px", top: tt.y + "px" }} onClick={(e) => e.stopPropagation()}>
        <Show when={tt.kind === "doc"}>{(() => { const d = tt as CtxTarget & { kind: "doc" }; return (<>
          {/* 文件夹/历史是两套清单：置顶与「从文件夹移除」只对文件夹成员开放，「从最近打开移除」只在历史面板开放 */}
          <Show when={d.meta.inLibrary}>
            {item(d.meta.pinned ? "取消置顶" : "置顶", "pin", d, "i-arrow-up")}
          </Show>
          {item("打开所在目录", "reveal", d, "i-folder-open")}
          {item("复制路径", "path", d, "i-copy")}
          {item("复制深度链接", "link", d, "i-external")}
          <div class="msep" />
          <Show when={d.meta.inLibrary}>
            {item("从文件夹移除", "unlibrary", d, "i-x")}
          </Show>
          <Show when={d.from === "recents"}>
            {item("从最近打开移除", "unrecent", d, "i-x")}
          </Show>
        </>); })()}</Show>
      </div>
    )}</Show>
  );
}

export function DropVeil(props: { on: boolean }) {
  return (
    <div id="dropveil" classList={{ on: props.on }}>
      松开鼠标即打开
      <small>支持 .md / .markdown / .txt · 多文件 · 整目录（{isTauri ? "真实磁盘路径" : "浏览器演示环境"}）</small>
    </div>
  );
}
