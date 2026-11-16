/* 左右栏分隔条：按住拖动改宽度，松手落一次偏好；双击回默认；键盘 ←/→ 步进、Home 重置。
 *
 * 三条约定：
 *  1) 拖动过程中只写 CSS 变量（即时反馈），不落盘——与位置防抖同一思路，避免每次 pointermove 打 DB；
 *  2) 宽度约束全在 lib/layout.ts 的纯函数里（有单测），这里只负责交互；
 *  3) 窗口缩窄时主动重新夹紧并回写，避免 --w-side 停留在一个已经放不下的值上。 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { useStore } from "../lib/store";
import { applySide, clampSide, sideMax, SIDE_DEFAULT, SIDE_MIN, STEP } from "../lib/layout";

export default function Splitter() {
  const s = useStore();
  let dragging = false;
  let detach: (() => void) | null = null;

  const current = () => clampSide(s.settings().sideWidth, innerWidth);

  function persist(px: number | null) {
    s.saveSettings({ sideWidth: px });
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = e.clientX;
    const from = current();
    const max = sideMax(innerWidth);
    dragging = true;
    document.querySelector(".win")?.classList.add("resizing");

    const at = (cx: number) => Math.min(Math.max(from + (cx - start), SIDE_MIN), max);
    const move = (ev: PointerEvent) => { applySide(at(ev.clientX)); };
    const up = (ev: PointerEvent) => {
      detach?.();
      detach = null;
      dragging = false;
      document.querySelector(".win")?.classList.remove("resizing");
      const px = at(ev.clientX);
      applySide(px);
      persist(px);                       // 松手才写 settings
      s.toast(`文件夹面板宽度 ${px} px`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }

  function onKey(e: KeyboardEvent) {
    const step = e.shiftKey ? STEP * 4 : STEP;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = current() - step;
    else if (e.key === "ArrowRight") next = current() + step;
    else if (e.key === "Home") next = SIDE_DEFAULT;
    if (next == null) return;
    e.preventDefault();
    const px = clampSide(next, innerWidth);
    applySide(px);
    persist(px);
  }

  // 宽度落 CSS 的唯一归属地就是这里（App 不参与）：
  // effect 依赖 settings.sideWidth，而启动时 onMount 会先于 settings 从 SQLite 返回跑一次，
  // 单靠 onMount 的结果就是"记着 317、重启还给 266"（实机核对抓到的 bug）——effect 会在设置到货后重放。
  createEffect(() => {
    const w = s.settings().sideWidth;
    applySide(clampSide(w, innerWidth));
  });

  onMount(() => {
    const onResize = () => {
      if (dragging) return;              // 拖动中由 pointermove 负责
      const px = clampSide(s.settings().sideWidth, innerWidth);
      applySide(px);
      if (px !== s.settings().sideWidth) persist(px);   // 窗口缩窄后回写越界值
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => { detach?.(); window.removeEventListener("resize", onResize); });
  });

  const px = () => current();
  return (
    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      tabindex={0}
      aria-valuenow={px()}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={sideMax(innerWidth)}
      title="拖动改变左右宽度 · 双击恢复默认 · ←/→ 微调（Shift 加速）"
      onPointerDown={onDown}
      onKeyDown={onKey}
      onDblClick={() => { applySide(SIDE_DEFAULT); persist(null); s.toast(`已恢复默认宽度 ${SIDE_DEFAULT} px`); }}
    >
      <span class="grip" />
    </div>
  );
}
