/* 编辑窗撤销/重做适配层单测（《Folio-编辑窗撤销/重做功能方案》v1.0）：
 * 直接对 CodeMirror 原生 history 做深/命令映射验证，不依赖真实 DOM。
 * 用 EditorState + 假 dispatch 组成 HistoryTarget（与 EditorView 的接口契约一致）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { historyDepths, undoOnce, redoOnce } from "../src/lib/editorHistory.ts";

function makeTarget() {
  let st = EditorState.create({ doc: "abc", extensions: [history({ newGroupDelay: 0 })] });
  return {
    get state() { return st; },
    dispatch: (tr: Transaction) => { st = st.update(tr).state; },
    type: (from: number, insert: string) => { const t = { state: st } as { state: EditorState };
      t.state = st; st = st.update({ changes: { from, insert } }).state; },
  };
}

test("历史深度映射：初始 0/0，一次变更后 undo=1", () => {
  const t = makeTarget();
  assert.deepEqual(historyDepths(t.state), { undo: 0, redo: 0 });
  t.type(3, "d");
  assert.equal(t.state.doc.toString(), "abcd");
  assert.deepEqual(historyDepths(t.state), { undo: 1, redo: 0 });
});

test("撤销/重做往返：内容与深度同步切换", () => {
  const t = makeTarget();
  t.type(3, "d");
  assert.equal(undoOnce(t), true, "有历史可撤销");
  assert.equal(t.state.doc.toString(), "abc");
  assert.deepEqual(historyDepths(t.state), { undo: 0, redo: 1 });
  assert.equal(redoOnce(t), true, "有历史可重做");
  assert.equal(t.state.doc.toString(), "abcd");
  assert.deepEqual(historyDepths(t.state), { undo: 1, redo: 0 });
});

test("撤销后继续输入：重做分支丢弃，redo 归零", () => {
  const t = makeTarget();
  t.type(3, "d");
  undoOnce(t);
  t.type(0, "x");
  assert.deepEqual(historyDepths(t.state), { undo: 1, redo: 0 });
  assert.equal(redoOnce(t), false, "重做分支已被新输入丢弃");
});

test("无历史：撤销/重做命令返回 false（菜单静默）", () => {
  const t = makeTarget();
  assert.equal(undoOnce(t), false);
  assert.equal(redoOnce(t), false);
  assert.equal(t.state.doc.toString(), "abc", "无历史不改内容");
});