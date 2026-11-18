/* 应用内询问框（UI 规范 v1.1 §8.6）：切换/关闭文档库、清空历史、退出确认等一律走这里，
 * 不再调起系统原生窗（confirmBox 与结构化 ask 共用本组件）。
 * 取消 / ✕ / 点遮罩 / Esc 一律 = 取消，零副作用；按钮等宽、取消居左（§8.2），焦点默认给取消。 */
import { For, Show } from "solid-js";
import * as ui from "../lib/ui";

export default function AskDialog() {
  return (
    <Show when={ui.askReq()} keyed>{(a) => (
      <div class="overlay mid open" id="ask-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) ui.finishAsk(false); }}>
        <div class="modal" style={{ width: "480px", "max-width": "94vw" }}>
          <div class="modal-h">
            <span class="mi2"><svg class="ico ico-18"><use href={"#" + (a.icon ?? "i-info")} /></svg></span>
            <div style={{ "min-width": "0" }}>
              <div class="mt">{a.title}</div>
              <Show when={a.sub}><div class="md2">{a.sub}</div></Show>
            </div>
            <span class="sp" />
            <span class="x" onClick={() => ui.finishAsk(false)}>
              <svg class="ico ico-14"><use href="#i-x" /></svg>
            </span>
          </div>
          <div class="modal-b">
            <For each={a.rows ?? []}>{([k, v]) => (
              <div class="krow"><span style={{ color: "var(--text-3)" }}>{k}</span><span class="sp" />
                <span class="ask-val">{v}</span></div>
            )}</For>
            <div class="ask-note" classList={{ plain: !!a.notePlain }}>{a.note}</div>
          </div>
          <div class="modal-f"><span class="sp" /><span class="mfb">
            <button class="btn" ref={(el) => queueMicrotask(() => el.focus())}
              onClick={() => ui.finishAsk(false)}>取消</button>
            <Show when={a.buttons} fallback={
              <button class="btn primary" onClick={() => ui.finishAsk(true)}>{a.ok ?? "确定"}</button>
            }>{(bs) => (
              <For each={bs()}>{(b) => (
                <button class={"btn" + (b.primary ? " primary" : "")}
                  onClick={() => ui.finishAsk(b.value)}>{b.label}</button>
              )}</For>
            )}</Show>
          </span></div>
        </div>
      </div>
    )}</Show>
  );
}
