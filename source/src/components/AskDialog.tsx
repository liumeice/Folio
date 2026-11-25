/* 应用内询问框（UI 规范 v1.1 §8.6）：切换/关闭文档库、清空历史、退出确认等一律走这里，
 * 不再调起系统原生窗（confirmBox 与结构化 ask 共用本组件）。
 * 取消 / ✕ / 点遮罩 / Esc 一律 = 取消，零副作用；按钮等宽、取消居左（§8.2），焦点默认给取消。 */
import { For, Show } from "solid-js";
import * as ui from "../lib/ui";
import { t } from "../lib/i18n";

export default function AskDialog() {
  return (
    <Show when={ui.askReq()} keyed>{(a) => (
      <div class="overlay mid open" id="ask-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) ui.finishAsk(false); }}>
        <div class="modal" style={{ width: "480px", "max-width": "94vw" }}>
          <div class="modal-h">
            <span class="mi2" classList={{ warn: a.icon === "i-warn-tri" }}>
              <svg class="ico ico-18"><use href={"#" + (a.icon ?? "i-info")} /></svg>
            </span>
            <div style={{ "min-width": "0" }}>
              <div class="mt">{a.title}</div>
              <Show when={a.sub}><div class="md2">{a.sub}</div></Show>
            </div>
            <span class="sp" />
            <span class="x" onClick={() => ui.finishAsk(false)}>
              <svg class="ico ico-14"><use href="#i-x" /></svg>
            </span>
          </div>
          <div class="modal-b" classList={{ "plain-box": !!a.plainBox }}>
            <For each={a.rows ?? []}>{([k, v, on]) => (
              <div class="krow"><span style={{ color: "var(--text-3)" }}>{k}</span><span class="sp" />
                <Show when={typeof v !== "string" || on}
                  fallback={<span class="ask-val">{v as string}</span>}>
                  {typeof v === "string"
                    ? <button type="button" class="ask-val link" title={v}
                        onClick={(e) => { e.stopPropagation(); on!(); }}>{v}</button>
                    : <span class="ask-val ask-parts">
                        <For each={v}>{(p) => p.onClick
                          ? <button type="button" class="ask-part link" title={p.text}
                              onClick={(e) => { e.stopPropagation(); p.onClick!(); }}>{p.text}</button>
                          : <span>{p.text}</span>}</For>
                      </span>}
                </Show></div>
            )}</For>
            <div class="ask-note" classList={{ plain: !!a.notePlain }}>{a.note}</div>
          </div>
          <div class="modal-f"><span class="sp" /><span class="mfb">
            <button class="btn" ref={(el) => queueMicrotask(() => el.focus())}
              onClick={() => ui.finishAsk(false)}>{t("common.action.cancel")}</button>
            <Show when={a.buttons} fallback={
              <button class="btn primary" onClick={() => ui.finishAsk(true)}>{a.ok ?? t("common.action.ok")}</button>
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
