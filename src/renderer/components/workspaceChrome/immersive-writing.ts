import type { Editor } from '@tiptap/core';
import { getActiveEditor } from '../../lib/active-editor';
import { useUiStore } from '../../store/ui-store';

/**
 * Immersive writing (沉浸写作): everything but the paper withdraws — both
 * sidebars, their toggles, the tab dock, the paper's toolbar, the Bottom
 * Panel — and every block but the caret's fades. The comment and outline
 * rails stay as the author left them. See docs/editor/immersive-writing.md.
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

export function enterImmersiveWriting(): void {
  const ui = useUiStore.getState();
  if (ui.immersiveWriting || ui.activeSuperView !== 'none') return;
  ui.setImmersiveWriting(true);
  keepWriting();
}

export function leaveImmersiveWriting(): void {
  const ui = useUiStore.getState();
  if (!ui.immersiveWriting) return;
  ui.setImmersiveWriting(false);
  keepWriting();
}

export function toggleImmersiveWriting(): void {
  if (useUiStore.getState().immersiveWriting) leaveImmersiveWriting();
  else enterImmersiveWriting();
}
