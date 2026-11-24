/* 界面语言下拉（设计 §2.1 / §4.2；原型 2026-11-24 定夺的紧凑形态）：
 * 行内只占一个按钮（旗帜 + 当前语言名 + chevron）；菜单挂 body（fixed 定位），
 * 按按钮矩形夹取并向上翻转，绕开设置卡片 / 滚动容器的 overflow 裁剪。
 * 语言名一律用自身语言显示（简体中文 / English）；「跟随系统」随当前界面语言。 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useStore } from "../lib/store";
import { resolveLocale, t } from "../lib/i18n";
import type { LanguagePref } from "../lib/i18n/types.ts";

function FlagCN() {
  return (
    <span class="lang-flag" aria-hidden="true">
      <svg viewBox="0 0 24 16">
        <rect width="24" height="16" fill="#DE2910" />
        <path d="M4.9 2.9l.82 1.72 1.88.24-1.38 1.3.35 1.87L4.9 7.2l-1.66.83.35-1.87L2.21 4.86l1.88-.24z" fill="#FFDE00" />
        <g fill="#FFDE00">
          <circle cx="9.2" cy="3.1" r=".62" /><circle cx="10.7" cy="4.6" r=".62" />
          <circle cx="10.7" cy="6.6" r=".62" /><circle cx="9.2" cy="8.1" r=".62" />
        </g>
      </svg>
    </span>
  );
}
function FlagUS() {
  return (
    <span class="lang-flag" aria-hidden="true">
      <svg viewBox="0 0 24 16">
        <rect width="24" height="16" fill="#fff" />
        <g fill="#B22234">
          <rect y="0" width="24" height="1.6" /><rect y="3.2" width="24" height="1.6" />
          <rect y="6.4" width="24" height="1.6" /><rect y="9.6" width="24" height="1.6" />
          <rect y="12.8" width="24" height="1.6" />
        </g>
        <rect width="10.6" height="8.6" fill="#3C3B6E" />
        <g fill="#fff">
          <circle cx="1.9" cy="1.9" r=".5" /><circle cx="4.3" cy="1.9" r=".5" /><circle cx="6.7" cy="1.9" r=".5" /><circle cx="9.1" cy="1.9" r=".5" />
          <circle cx="3.1" cy="3.5" r=".5" /><circle cx="5.5" cy="3.5" r=".5" /><circle cx="7.9" cy="3.5" r=".5" />
          <circle cx="1.9" cy="5.2" r=".5" /><circle cx="4.3" cy="5.2" r=".5" /><circle cx="6.7" cy="5.2" r=".5" /><circle cx="9.1" cy="5.2" r=".5" />
          <circle cx="3.1" cy="6.9" r=".5" /><circle cx="5.5" cy="6.9" r=".5" /><circle cx="7.9" cy="6.9" r=".5" />
        </g>
      </svg>
    </span>
  );
}
function Globe() {
  return (
    <span class="lang-flag globe" aria-hidden="true">
      <svg class="ico ico-14"><use href="#i-globe" /></svg>
    </span>
  );
}

export default function LangSelect() {
  const s = useStore();
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  function place() {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const mw = menu?.offsetWidth ?? 196;
    const mh = menu?.offsetHeight ?? 0;
    const pad = 8;
    let left = r.right - mw;
    if (left < pad) left = r.left;
    left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - mw - pad));
    let top = r.bottom + 5;
    if (mh && top + mh > window.innerHeight - pad) top = Math.max(pad, r.top - mh - 5);   // 下方不够 → 向上翻转
    setPos({ left, top });
  }
  function show() { setOpen(true); queueMicrotask(place); }
  function hide() { setOpen(false); }

  function choose(pref: LanguagePref) {
    hide();
    if (pref === s.settings().language) return;
    s.saveSettings({ language: pref });
    // toast 用「新语言」显示（设计 §2.4）：等 locale 信号随设置更新后再取文案
    const target = resolveLocale(pref);
    queueMicrotask(() => s.toast(t(target === "zh-CN" ? "toast.language.zh" : "toast.language.en")));
  }

  const pref = () => s.settings().language;
  const label = () => pref() === "auto" ? t("settings.option.language.auto")
    : pref() === "zh-CN" ? "简体中文" : "English";
  const options = (): { value: LanguagePref; label: string; icon: () => JSX.Element }[] => [
    { value: "auto", label: t("settings.option.language.auto"), icon: Globe },
    { value: "zh-CN", label: "简体中文", icon: FlagCN },
    { value: "en-US", label: "English", icon: FlagUS },
  ];

  onMount(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open()) return;
      const tgt = e.target as Node | null;
      if (tgt && (btn?.contains(tgt) || menu?.contains(tgt))) return;
      hide();
    };
    const onScroll = () => { if (open()) hide(); };
    const onResize = () => { if (open()) hide(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && open()) hide(); };
    document.addEventListener("click", onDoc);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <>
      <button ref={btn} type="button" class="lang-select" aria-haspopup="listbox" aria-expanded={open()}
        onClick={(e) => { e.stopPropagation(); if (open()) hide(); else show(); }}>
        {pref() === "auto" ? <Globe /> : pref() === "zh-CN" ? <FlagCN /> : <FlagUS />}
        <span>{label()}</span>
        <svg class="ico ico-12 lang-chev"><use href="#i-chev-d" /></svg>
      </button>
      <Show when={open()}>
        <Portal mount={document.body}>
          <div ref={(el) => { menu = el; place(); }} class="lang-menu" role="listbox"
            style={{ left: pos().left + "px", top: pos().top + "px" }}>
            <For each={options()}>{(o) => (
              <button type="button" class="lang-item" role="option" aria-checked={pref() === o.value}
                onClick={(e) => { e.stopPropagation(); choose(o.value); }}>
                {o.icon()}
                <span>{o.label}</span>
                <Show when={pref() === o.value}>
                  <svg class="ico ico-12 lang-check"><use href="#i-check" /></svg>
                </Show>
              </button>
            )}</For>
          </div>
        </Portal>
      </Show>
    </>
  );
}