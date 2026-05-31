/**
 * Registry of *live* Y.Docs — the in-memory documents an open editor is bound
 * to. Keyed by the canonical docId (see lib/yjs-doc-id).
 *
 * The agent's prose-edit tools run in the renderer but outside React, so they
 * can't reach an editor's Y.Doc through hooks. This registry lets them find the
 * exact Y.Doc an open editor is using, so an agent edit shows up live (and is
 * persisted/synced by that editor's existing update handler) instead of only
 * touching SQLite. When no editor is open for a doc, the agent rehydrates a
 * transient Y.Doc from SQLite instead (see lib/agent/chapter-prose).
 */
import type * as Y from 'yjs';

const liveDocs = new Map<string, Y.Doc>();

/** Register an editor's live Y.Doc. Returns an unregister fn for cleanup. */
export function registerLiveYDoc(docId: string, doc: Y.Doc): () => void {
  liveDocs.set(docId, doc);
  return () => {
    // Only delete if it's still us — a remount may have replaced the entry.
    if (liveDocs.get(docId) === doc) liveDocs.delete(docId);
  };
}

/** The live Y.Doc for this docId, or undefined if no editor is currently open. */
export function getLiveYDoc(docId: string): Y.Doc | undefined {
  return liveDocs.get(docId);
}
