/* 编辑窗撤销/重做适配层（《Folio-编辑窗撤销/重做功能方案》v1.0，2026-11-23）。
 * 直接复用 CodeMirror 6 原生 history（basicSetup 已含），不引入第二套历史：
 *  - 只把「命令 + 历史深度」包成可单测的纯适配层（EditorState + 假 dispatch 即可测）；
 *  - 菜单层不接触 EditorView，经 EditorBridge 调用；历史深度由编辑器事务回写给 ui 信号。
 * 历史是「编辑会话内」能力：保存/放弃/切换页签会卸载编辑器，历史随之清空（产品口径）。 */
import { Annotation, type EditorState, type Transaction } from "@codemirror/state";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";

/** 命令事务的显示名（Word 式撤销列表用）。命令事务另带 userEvent，
 *  避免相邻命令/命令与输入被 CodeMirror 合并成一步。 */
export const editLabel = Annotation.define<string>();

/** 命令目标：EditorView 天然满足（state 取值 + dispatch(tr)） */
export interface HistoryTarget {
  state: EditorState;
  dispatch(tr: Transaction): void;
}

export function historyDepths(state: EditorState) {
  return { undo: undoDepth(state), redo: redoDepth(state) };
}

export function undoOnce(target: HistoryTarget) {
  return undo(target);
}

export function redoOnce(target: HistoryTarget) {
  return redo(target);
}