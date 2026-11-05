import type { Editor } from '@tiptap/core';
import { getActiveEditor } from '../../lib/active-editor';
import { useUiStore } from '../../store/ui-store';

/**
 * Immersive writing (沉浸写作): everything but the paper withdraws — both
 * sidebars, their toggles, the tab dock, the paper's toolbar, the Bottom
 * Panel — and every block but the caret's fades. The comment and outline
 * rails stay as the author left them. With 打字时自动沉浸 on, typing in the
 * paper begins it. See docs/editor/immersive-writing.md.
 */

function visibleEditor(): Editor | null {
  const editor = getActiveEditor();
  if (!editor) return null;
  // Kept-alive tabs hide their editors; never put the caret in one of those.
  const dom = editor.view.dom;
  if (!dom.isConnected || dom.getClientRects().length === 0) return null;
  return getComputedStyle(dom).visibility === 'hidden' ? null : editor;
}

/** The caret goes back to where it was, so typing carries on at once. */
function keepWriting(): void {
  visibleEditor()?.commands.focus();
}

/**
 * Whether `target` is in the editor showing on the stage, ready for text:
 * where typing begins a sitting (打字时自动沉浸). The Agent's composer, the
 * plot planner and fields in the sidebars are not the paper.
 */
export function isStageEditorTarget(target: EventTarget | null, stage: Element | null): boolean {
  const editor = visibleEditor();
  if (!editor || !stage || !(target instanceof Node)) return false;
  const dom = editor.view.dom;
  return editor.isEditable && !editor.view.composing && stage.contains(dom) && dom.contains(target);
}

/**
 * `byTyping`: the author's typing began it (打字时自动沉浸). The caret is
 * already in the editor, and a press off the text ends such a sitting.
 */
export function enterImmersiveWriting({ byTyping = false }: { byTyping?: boolean } = {}): void {
  const ui = useUiStore.getState();
  if (ui.immersiveWriting || ui.activeSuperView !== 'none') return;
  ui.setImmersiveWriting(true, byTyping);
  if (!byTyping) keepWriting();
}

/** `refocus: false` when a press elsewhere ends it: that press decides where focus goes. */
export function leaveImmersiveWriting({ refocus = true }: { refocus?: boolean } = {}): void {
  const ui = useUiStore.getState();
  if (!ui.immersiveWriting) return;
  ui.setImmersiveWriting(false);
  if (refocus) keepWriting();
}

export function toggleImmersiveWriting(): void {
  if (useUiStore.getState().immersiveWriting) leaveImmersiveWriting();
  else enterImmersiveWriting();
}
