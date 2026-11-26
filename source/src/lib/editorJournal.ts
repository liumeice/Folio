/* 编辑历史下拉的数据层（Word 式撤销/重做列表，2026-11-26 原型 editor-history.html）。
 *
 * 以 CodeMirror 的 undoDepth 为锚：
 *   - depth +1 → 新的一步（CM 也新建了历史事件）；
 *   - depth 不变 → 连续输入被 CM 合并，把文本并进当前步即可与一次 Ctrl+Z 对齐；
 *   - undo/redo 事务只同步指针，不增删日志（保留重做分支）。
 * 纯数据层：不读 locale、不碰 DOM；显示文案由 EditorPane 按 kind + 文本渲染。
 * 命令事务由 EditorPane 带 editLabel 注解和 userEvent，保证"一次命令=一步"不被 CM 合并。 */
import type { Transaction } from "@codemirror/state";

export type JournalKind = "type" | "delete" | "replace" | "cmd";

export interface JournalStep {
  /** 1-based：这一步执行完后的 undoDepth（跳转目标靠它） */
  depth: number;
  kind: JournalKind;
  /** 插入文本；kind=cmd 时存命令的显示标签 */
  added: string;
  /** 删除文本 */
  removed: string;
}

export interface JournalState {
  steps: JournalStep[];
  /** 当前 undoDepth（步骤指针） */
  depth: number;
  /** 当前 redoDepth，仅用于与 CM 修剪对齐 */
  redo: number;
}

export const emptyJournal = (): JournalState => ({ steps: [], depth: 0, redo: 0 });

/** 文本只留前 80 字符：列表标签只显示首行片段，不必长期持有大段删除文本 */
const TEXT_CAP = 80;
const cap = (s: string) => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s);

/** 从一次事务里取插入/删除文本（多光标时按顺序拼接） */
export function txTexts(tr: Transaction): { added: string; removed: string } {
  let added = "";
  let removed = "";
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    added += inserted.toString();
    removed += tr.startState.doc.sliceString(fromA, toA);
  });
  return { added, removed };
}

export interface JournalUpdate {
  undoDepth: number;
  redoDepth: number;
  /** 撤销/重做事务：只同步指针 */
  navigation?: boolean;
  added?: string;
  removed?: string;
  /** 命令事务的显示标签（为空 = 普通输入/删除） */
  label?: string;
}

export function reduceJournal(state: JournalState, u: JournalUpdate): JournalState {
  const total = u.undoDepth + u.redoDepth;
  let steps = state.steps;
  // CM 的 minDepth 修剪掉最老事件后，日志头部同步裁掉并重排 depth
  if (steps.length > total) {
    steps = steps.slice(steps.length - total).map((s, i) => ({ ...s, depth: i + 1 }));
  }

  if (u.navigation) {
    return { steps, depth: u.undoDepth, redo: u.redoDepth };
  }

  if (u.undoDepth > state.depth) {
    // 新步骤：先截掉重做分支，再从当前指针往后补（正常只 +1；多事件时逐个补）
    const base = steps.slice(0, state.depth);
    const added = cap(u.added ?? "");
    const removed = cap(u.removed ?? "");
    const kind: JournalKind = u.label ? "cmd" : added && removed ? "replace" : added ? "type" : "delete";
    let depth = state.depth;
    while (depth < u.undoDepth) {
      depth += 1;
      base.push({
        depth,
        kind,
        added: kind === "cmd" ? (u.label ?? "") : added,
        removed,
      });
    }
    return { steps: base, depth: u.undoDepth, redo: u.redoDepth };
  }

  if (u.undoDepth === state.depth && state.depth > 0 && steps.length >= state.depth) {
    // 连续输入被 CM 合并：把新文本并进当前步（命令步不合并）
    const i = state.depth - 1;
    const prev = steps[i];
    if (prev && prev.kind !== "cmd" && !u.label) {
      const added = cap(prev.added + (u.added ?? ""));
      const removed = cap(prev.removed + (u.removed ?? ""));
      const kind: JournalKind = added && removed ? "replace" : added ? "type" : "delete";
      steps = steps.slice();
      steps[i] = { ...prev, kind, added, removed };
    }
    return { steps, depth: u.undoDepth, redo: u.redoDepth };
  }

  // 其它情况（例如文档整体换掉）：只同步指针，保持日志不被误删
  return { steps, depth: u.undoDepth, redo: u.redoDepth };
}

/** 列表标签用的首行片段（空内容返回空串，由 UI 决定显示「键入」还是带文本） */
export function historySnippet(text: string, max = 24): string {
  const first = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return first.length > max ? first.slice(0, max) + "…" : first;
}