// Edits to a material note's checklist made outside its editor: when a TODO
// projected from a note task is deleted (Review panel, Agent), its line goes
// with it, so the note and the TODO list keep agreeing; a history restore
// relinks the lines it brings back. The note may be open in an editor (live
// Y.Doc) or closed (rehydrated from SQLite and journaled like any authored
// edit).

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

function forEachTaskItem(parent: Y.XmlFragment | Y.XmlElement, visit: (item: Y.XmlElement) => void): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'taskItem') visit(child);
    forEachTaskItem(child, visit);
  }
}

/** The TODO ids the checklist links to. */
export function yLinkedTaskIds(fragment: Y.XmlFragment): Set<string> {
  const ids = new Set<string>();
  forEachTaskItem(fragment, (item) => {
    const todoId = item.getAttribute('todoId');
    if (typeof todoId === 'string' && todoId !== '') ids.add(todoId);
  });
  return ids;
}

const isTaskList = (node: unknown): node is Y.XmlElement =>
  node instanceof Y.XmlElement && node.nodeName === 'taskList';

/**
 * Removes every task item linked to one of `todoIds`, and any task list it
 * leaves empty (the note schema requires at least one item per list). A
 * removed item's sub-tasks are TODOs of their own: they move up into its
 * place.
 */
export function yRemoveLinkedTaskItems(fragment: Y.XmlFragment, todoIds: ReadonlySet<string>): number {
  let removed = 0;
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (let index = parent.length - 1; index >= 0; index -= 1) {
      const child = parent.get(index);
      if (!(child instanceof Y.XmlElement)) continue;
      visit(child);
      const todoId = child.getAttribute('todoId');
      if (child.nodeName === 'taskItem' && typeof todoId === 'string' && todoIds.has(todoId)) {
        const subTasks = child
          .toArray()
          .filter(isTaskList)
          .flatMap((list) => list.toArray())
          .map((item) => item.clone() as Y.XmlElement);
        parent.delete(index, 1);
        if (subTasks.length > 0) parent.insert(index, subTasks);
        removed += 1;
      } else if (child.nodeName === 'taskList' && child.length === 0) {
        parent.delete(index, 1);
      }
    }
  };
  visit(fragment);
  return removed;
}

/**
 * Points task items (by block id) at new TODOs; null leaves a line to be
 * projected when the note is next opened. Returns how many changed.
 */
export function ySetTaskLinks(fragment: Y.XmlFragment, links: ReadonlyMap<string, string | null>): number {
  let changed = 0;
  forEachTaskItem(fragment, (item) => {
    const blockId = item.getAttribute('id');
    if (typeof blockId !== 'string' || !links.has(blockId)) return;
    const todoId = links.get(blockId) ?? null;
    if ((item.getAttribute('todoId') ?? null) === todoId) return;
    if (todoId === null) item.removeAttribute('todoId');
    else item.setAttribute('todoId', todoId);
    changed += 1;
  });
  return changed;
}

async function hydrateStoredNote(docId: string): Promise<Y.Doc | null> {
  const repo = createYjsRepository();
  if (!(await repo.hasDocState(docId))) return null;
  const doc = new Y.Doc();
  const snapshot = await repo.getSnapshot(docId);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
  for (const update of await repo.listUpdates(docId)) Y.applyUpdate(doc, update.updateBlob, 'load');
  return doc;
}

/**
 * The TODO ids the note's checklist links to now, live or stored. A
 * never-opened note only has its seed, which links nothing.
 */
export async function readNoteTaskLinks(noteId: string): Promise<Set<string>> {
  const docId = makeDocId('library-item', noteId);
  const live = getLiveYDoc(docId);
  if (live) return yLinkedTaskIds(live.getXmlFragment('default'));
  const doc = await hydrateStoredNote(docId);
  if (!doc) return new Set();
  try {
    return yLinkedTaskIds(doc.getXmlFragment('default'));
  } finally {
    doc.destroy();
  }
}

/**
 * Applies `edit` to the note's document as a local authored edit. Returns the
 * note's new body JSON for the caller to project, or null when `edit` changed
 * nothing or the note has no document yet.
 */
async function editNoteDocument(
  projectId: string,
  noteId: string,
  edit: (fragment: Y.XmlFragment) => number,
): Promise<string | null> {
  const docId = makeDocId('library-item', noteId);

  const live = getLiveYDoc(docId);
  if (live) {
    let changed = 0;
    live.transact(() => {
      changed = edit(live.getXmlFragment('default'));
    }, NOTE_TASK_ORIGIN);
    if (changed === 0) return null;
    await flushOpenYjsDocument(docId);
    return JSON.stringify(yDocToProsemirrorJSON(live, 'default'));
  }

  const doc = await hydrateStoredNote(docId);
  if (!doc) return null;
  try {
    const diff: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === NOTE_TASK_ORIGIN) diff.push(new Uint8Array(update));
    };
    let changed = 0;
    doc.on('update', onUpdate);
    doc.transact(() => {
      changed = edit(doc.getXmlFragment('default'));
    }, NOTE_TASK_ORIGIN);
    doc.off('update', onUpdate);
    if (changed === 0) return null;
    for (const update of diff) await appendAuthoredYjsUpdate(projectId, docId, update, { kind: 'user' });
    const fullState = Y.encodeStateAsUpdate(doc);
    await createYjsRepository().upsertSnapshot(docId, fullState, { advanceRevision: false });
    maybeCaptureSnapshotHistory(docId, fullState);
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } finally {
    doc.destroy();
  }
}

/** Removes the note's task lines linked to `todoIds` (see editNoteDocument). */
export async function removeNoteTaskLines(
  projectId: string,
  noteId: string,
  todoIds: readonly string[],
): Promise<string | null> {
  const ids = new Set(todoIds);
  if (ids.size === 0) return null;
  return editNoteDocument(projectId, noteId, (fragment) => yRemoveLinkedTaskItems(fragment, ids));
}

/**
 * Links one line to a new TODO when the note closed while the TODO was being
 * saved, provided the line still points where it did then (`from`). Returns
 * whether it linked.
 */
export async function linkNoteTaskLine(
  projectId: string,
  noteId: string,
  blockId: string,
  todoId: string,
  from: string | null,
): Promise<boolean> {
  const body = await editNoteDocument(projectId, noteId, (fragment) => {
    let linked = 0;
    forEachTaskItem(fragment, (item) => {
      if (linked > 0 || item.getAttribute('id') !== blockId) return;
      if ((item.getAttribute('todoId') ?? null) !== from) return;
      item.setAttribute('todoId', todoId);
      linked = 1;
    });
    return linked;
  });
  return body !== null;
}

/** Relinks the note's task lines, by block id (see ySetTaskLinks, editNoteDocument). */
export async function setNoteTaskLinks(
  projectId: string,
  noteId: string,
  links: ReadonlyMap<string, string | null>,
): Promise<string | null> {
  if (links.size === 0) return null;
  return editNoteDocument(projectId, noteId, (fragment) => ySetTaskLinks(fragment, links));
}
