import { For } from "solid-js";
import { useStore } from "../lib/store";

export default function ToastZone() {
  const s = useStore();
  return (
    <div class="toast-zone" aria-live="polite">
      <For each={s.toasts()}>{(t) => <div class="toast" role="status">{t.text}</div>}</For>
    </div>
  );
}
