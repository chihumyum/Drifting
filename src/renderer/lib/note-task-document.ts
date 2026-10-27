// Edits to a material note's checklist made outside its editor: when a TODO
// projected from a note task is deleted (Review panel, Agent), its line goes
// with it, so the note and the TODO list keep agreeing. The note may be open
// in an editor (live Y.Doc) or closed (rehydrated from SQLite and journaled
// like any authored edit).

import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

import { makeDocId } from './yjs-doc-id';
import { getLiveYDoc } from './yjs-doc-registry';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { flushOpenYjsDocument } from '../services/yjs-local-durability.service';
import { maybeCaptureSnapshotHistory } from '../services/snapshot-history.service';
import { appendAuthoredYjsUpdate } from '../sync/journal/yjs-update';

/** A local, user-authored edit (not 'remote'/'load'/'agent'), journaled as such. */
const NOTE_TASK_ORIGIN = 'note-task-todo';

/**
 * Removes every task item linked to one of `todoIds`, and any task list it
 * leaves empty (the note schema requires at least one item per list).
 */
export function yRemoveLinkedTaskItems(fragment: Y.XmlFragment, todoIds: ReadonlySet<string>): number {
  let removed = 0;
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (let index = parent.length - 1; index >= 0; index -= 1) {
      const child = parent.get(index);
      if (!(child instanceof Y.XmlElement)) continue;
      const todoId = child.getAttribute('todoId');
      if (child.nodeName === 'taskItem' && typeof todoId === 'string' && todoIds.has(todoId)) {
        parent.delete(index, 1);
        removed += 1;
        continue;
      }
      visit(child);
      if (child.nodeName === 'taskList' && child.length === 0) parent.delete(index, 1);
    }
  };
  visit(fragment);
  return removed;
}

function hasLinkedTaskItem(fragment: Y.XmlFragment, todoIds: ReadonlySet<string>): boolean {
  const visit = (parent: Y.XmlFragment | Y.XmlElement): boolean =>
    parent.toArray().some((child) => {
      if (!(child instanceof Y.XmlElement)) return false;
      const todoId = child.getAttribute('todoId');
      if (child.nodeName === 'taskItem' && typeof todoId === 'string' && todoIds.has(todoId)) return true;
      return visit(child);
    });
  return visit(fragment);
}

/**
 * Removes the note's task lines linked to `todoIds`. Returns the note's new
 * body JSON for the caller to project, or null when nothing was linked (or
 * the note has no document yet: a never-opened note only has its seed, which
 * links nothing until it is first edited).
 */
export async function removeNoteTaskLines(
  projectId: string,
  noteId: string,
  todoIds: readonly string[],
): Promise<string | null> {
  const ids = new Set(todoIds);
  if (ids.size === 0) return null;
  const docId = makeDocId('library-item', noteId);

  const live = getLiveYDoc(docId);
  if (live) {
    if (!hasLinkedTaskItem(live.getXmlFragment('default'), ids)) return null;
    live.transact(() => yRemoveLinkedTaskItems(live.getXmlFragment('default'), ids), NOTE_TASK_ORIGIN);
    await flushOpenYjsDocument(docId);
    return JSON.stringify(yDocToProsemirrorJSON(live, 'default'));
  }

  const repo = createYjsRepository();
  if (!(await repo.hasDocState(docId))) return null;
  const doc = new Y.Doc();
  try {
    const snapshot = await repo.getSnapshot(docId);
    if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
    for (const update of await repo.listUpdates(docId)) Y.applyUpdate(doc, update.updateBlob, 'load');
    const fragment = doc.getXmlFragment('default');
    if (!hasLinkedTaskItem(fragment, ids)) return null;
    const diff: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === NOTE_TASK_ORIGIN) diff.push(new Uint8Array(update));
    };
    doc.on('update', onUpdate);
    doc.transact(() => yRemoveLinkedTaskItems(fragment, ids), NOTE_TASK_ORIGIN);
    doc.off('update', onUpdate);
    for (const update of diff) await appendAuthoredYjsUpdate(projectId, docId, update, { kind: 'user' });
    const fullState = Y.encodeStateAsUpdate(doc);
    await repo.upsertSnapshot(docId, fullState, { advanceRevision: false });
    maybeCaptureSnapshotHistory(docId, fullState);
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } finally {
    doc.destroy();
  }
}
