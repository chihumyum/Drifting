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

interface LiveDocEntry {
  doc: Y.Doc;
  references: number;
}

const liveDocs = new Map<string, LiveDocEntry>();

/** Register an editor's live Y.Doc. Returns an unregister fn for cleanup. */
export function registerLiveYDoc(docId: string, doc: Y.Doc): () => void {
  const existing = liveDocs.get(docId);
  if (existing && existing.doc !== doc) {
    throw new Error(`A different live Y.Doc is already registered for ${docId}`);
  }
  const entry = existing ?? { doc, references: 0 };
  entry.references += 1;
  liveDocs.set(docId, entry);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = liveDocs.get(docId);
    if (!current || current.doc !== doc) return;
    current.references -= 1;
    if (current.references <= 0) liveDocs.delete(docId);
  };
}

/** The live Y.Doc for this docId, or undefined if no editor is currently open. */
export function getLiveYDoc(docId: string): Y.Doc | undefined {
  return liveDocs.get(docId)?.doc;
}
