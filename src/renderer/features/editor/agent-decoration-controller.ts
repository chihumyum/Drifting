import type { Editor } from '@tiptap/core';
import { DecorationSet } from '@tiptap/pm/view';
import type { ProseEntityType } from '../../lib/yjs-doc-id';
import { AgentDiffPluginKey, buildAgentEditorDecorations } from '../../lib/extensions/agent-diff-decoration';
import { createAgentDecorationSelector, type AgentDecorationSnapshot } from './agent-decoration-projection';

export interface AgentDecorationStore {
  getState(): AgentDecorationSnapshot;
  subscribe(listener: (state: AgentDecorationSnapshot) => void): () => void;
}

/** Owns only derived decorations. Never owns/destroys the editor or its Y.Doc. */
export function attachAgentDecorationController(input: {
  editor: Editor;
  entityType: ProseEntityType;
  entityId: string;
  store: AgentDecorationStore;
  presentationNeeded: boolean;
  onReady(ready: boolean): void;
  onError(error: unknown): void;
}) {
  const { editor, store } = input;
  const select = createAgentDecorationSelector(input.entityType, input.entityId);
  let projection = select(store.getState());
  let presentationNeeded = input.presentationNeeded;
  let dirty = true;
  let disposed = false;
  let lastReady: boolean | undefined;
  const ready = (value: boolean) => {
    if (lastReady === value) return;
    lastReady = value;
    input.onReady(value);
  };
  const hasProjection = () => projection.approveChanges.length > 0 || projection.autoRevealBlockIds !== undefined;
  const flush = () => {
    if (disposed || editor.isDestroyed) return;
    if (!dirty) { ready(true); return; }
    if (!presentationNeeded) { ready(false); return; }
    try {
      const current = AgentDiffPluginKey.getState(editor.state);
      if (!current) throw new Error('Agent decoration plugin is missing');
      const next = hasProjection()
        ? buildAgentEditorDecorations(editor.state.doc, projection.approveChanges, projection.autoRevealBlockIds)
        : DecorationSet.empty;
      if (current !== DecorationSet.empty || next !== DecorationSet.empty) {
        editor.view.dispatch(editor.state.tr.setMeta(AgentDiffPluginKey, next));
      }
      editor.view.dom.removeAttribute('data-agent-projection-blocked');
      dirty = false;
      ready(true);
    } catch (error) {
      // Never reveal canonical text with a failed/stale review projection.
      editor.view.dom.setAttribute('data-agent-projection-blocked', 'true');
      ready(false);
      input.onError(error);
    }
  };
  const changed = () => {
    // Most edits have no pending review. Avoid an empty meta transaction on
    // every keystroke, including invisible editors receiving remote prose.
    if (!hasProjection() && AgentDiffPluginKey.getState(editor.state) === DecorationSet.empty) {
      dirty = false;
      editor.view.dom.removeAttribute('data-agent-projection-blocked');
      ready(true);
      return;
    }
    dirty = true;
    flush();
  };
  const unsubscribe = store.subscribe((state) => {
    if (disposed || editor.isDestroyed) return;
    const next = select(state);
    if (next === projection) return;
    projection = next;
    changed();
  });
  const onUpdate = () => { if (!disposed && !editor.isDestroyed) changed(); };
  editor.on('update', onUpdate);
  changed();
  return {
    setPresentationNeeded(value: boolean) {
      if (disposed || editor.isDestroyed) return;
      presentationNeeded = value;
      if (value) flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      editor.off('update', onUpdate);
      if (!editor.isDestroyed) editor.view.dom.removeAttribute('data-agent-projection-blocked');
    },
  };
}
