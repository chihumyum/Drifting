import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import loglevel from 'loglevel';

import { useDataStore } from '../store/data-store';
import { useComment } from '../usecase/useComment';
import { linkNoteTaskLine } from '../lib/note-task-document';
import {
  createPlainCommentDoc,
  extractTextFromCommentBody,
  noteTaskTodoInput,
  type Comment,
} from '../domain/comment';

const log = loglevel.getLogger('note-todo-links');
log.setLevel(loglevel.levels.ERROR);

/** Marks transactions this module makes, so they are not read as author edits. */
const LINK_META = 'noteTodoLink';
/** Quiet time after the last edit before the checklist is reconciled. */
const RECONCILE_DELAY_MS = 1200;

// A task item's `todoId`: a string links it to that TODO, '' keeps it a plain
// checkbox (the author unlinked it), null means it was never linked and is
// projected once the author finishes the line. A link whose TODO is not in
// the store acts as a plain checkbox but stays in the document: the TODO may
// still be on its way from another device.

export interface NoteTask {
  pos: number;
  node: PMNode;
  blockId: string | null;
  todoId: string | null;
  checked: boolean;
  text: string;
}

type TaskSnapshot = Pick<NoteTask, 'text' | 'todoId' | 'checked'>;

const snapshotTasks = (tasks: readonly NoteTask[]) =>
  new Map<string, TaskSnapshot>(
    tasks
      .filter((task) => task.blockId)
      .map((task) => [task.blockId!, { text: task.text, todoId: task.todoId, checked: task.checked }]),
  );

function ownText(node: PMNode): string {
  let text = '';
  node.forEach((child) => {
    if (child.type.name !== 'taskList') text += child.textContent;
  });
  return text.trim();
}

export function noteTasks(doc: PMNode): NoteTask[] {
  const tasks: NoteTask[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return;
    tasks.push({
      pos,
      node,
      blockId: typeof node.attrs.id === 'string' ? node.attrs.id : null,
      todoId: typeof node.attrs.todoId === 'string' ? node.attrs.todoId : null,
      checked: Boolean(node.attrs.checked),
      text: ownText(node),
    });
  });
  return tasks;
}

const isLinked = (todoId: string | null): todoId is string => typeof todoId === 'string' && todoId !== '';

/** The TODO a line's link resolves to, if it exists. */
function linkedTodo(todoId: string | null, byId: ReadonlyMap<string, Comment>): Comment | null {
  if (!isLinked(todoId)) return null;
  const todo = byId.get(todoId);
  return todo?.kind === 'todo' ? todo : null;
}

const commentsById = () => new Map(useDataStore.getState().comments.map((comment) => [comment.id, comment]));

/** Whether the line's link resolves to a TODO this device has. */
export function hasLinkedTodo(todoId: string | null, comments: readonly Comment[]): boolean {
  return isLinked(todoId) && comments.some((comment) => comment.id === todoId && comment.kind === 'todo');
}

interface ReconcileQueue {
  running: boolean;
  queued: { flush: boolean } | null;
}

/**
 * Runs one reconcile at a time. A request made while one runs is not dropped:
 * it runs once the current one ends (requests made meanwhile merge, and a
 * flush wins).
 */
export async function runSerially(
  queue: ReconcileQueue,
  options: { flush: boolean },
  run: (options: { flush: boolean }) => Promise<void>,
): Promise<void> {
  if (queue.running) {
    queue.queued = { flush: options.flush || Boolean(queue.queued?.flush) };
    return;
  }
  queue.running = true;
  try {
    await run(options);
  } finally {
    queue.running = false;
  }
  const next = queue.queued;
  queue.queued = null;
  if (next) await runSerially(queue, next, run);
}

/** The task item around the selection, if any. */
export function taskItemAtSelection(editor: Editor): { pos: number; node: PMNode } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'taskItem') return { pos: $from.before(depth), node };
  }
  return null;
}

function taskPosition(editor: Editor, blockId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'taskItem' && node.attrs.id === blockId) found = pos;
    return undefined;
  });
  return found;
}

function isRemote(transaction: Transaction): boolean {
  const sync = transaction.getMeta('y-sync$') as { isChangeOrigin?: boolean } | undefined;
  return Boolean(sync?.isChangeOrigin);
}

/**
 * Keeps a note's checklist and the project's TODOs agreeing
 * (docs/material-workbench.md):
 *
 * - A finished task line (the caret has left it, or the editor lost focus)
 *   becomes a TODO about the note, anchored to the line. Lines already in
 *   the note are projected when it opens. Off when the note's `taskTodos`
 *   switch is off; linking by hand still works.
 * - Editing a linked line updates its TODO's text; removing the line deletes
 *   the TODO. Deleting the TODO elsewhere removes the line (useComment).
 * - The TODO owns the status: resolving or reopening it anywhere moves the
 *   checkbox, and ticking the checkbox resolves or reopens it.
 *
 * Only the author's own edits on this device create, edit or delete TODOs;
 * edits arriving from other devices were reconciled where they were made. A
 * link to a TODO this device lacks is never rewritten here: the TODO may
 * still be syncing, and the line acts as a plain checkbox until it arrives.
 */
export function useNoteTodoLinks({
  editor,
  ready,
  noteId,
  taskTodos,
  projectId,
  userId,
}: {
  editor: Editor | null;
  /** The editor shows the note's document (not its empty pre-hydration state). */
  ready: boolean;
  noteId: string;
  taskTodos: boolean;
  projectId: string;
  userId: string;
}) {
  const comments = useDataStore((state) => state.comments);
  const commentUsecases = useComment({ projectId, userId });
  // Last status this note agreed on, per TODO; tells which side changed.
  const agreed = useRef(new Map<string, 'open' | 'resolved'>());
  // Task lines the author touched since the last reconcile, by block id.
  const dirty = useRef(new Set<string>());
  // TODO links that disappeared from the note in the author's own edits.
  const removed = useRef(new Set<string>());
  // TODOs this session deleted because their line went away (undo brings
  // the line back unlinked, ready to be projected again).
  const deletedHere = useRef(new Set<string>());
  // Lines the author's edits gave a link they did not have (a paste of a
  // linked line, here or from another note), by block id.
  const relinked = useRef(new Set<string>());
  // Lines already in the note are projected once, when it is first shown.
  const sweepPending = useRef(true);
  const previous = useRef(new Map<string, TaskSnapshot>());
  const queue = useRef<ReconcileQueue>({ running: false, queued: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ comments, commentUsecases, taskTodos });
  useEffect(() => {
    latest.current = { comments, commentUsecases, taskTodos };
  }, [commentUsecases, comments, taskTodos]);

  const reconcile = useCallback(
    (options: { flush: boolean }) =>
      runSerially(queue.current, options, async ({ flush }) => {
        if (!editor || editor.isDestroyed) return;
        try {
          const { commentUsecases: usecases, taskTodos: projecting } = latest.current;
          const byId = commentsById();
          const sweep = sweepPending.current && ready;
          if (sweep) {
            sweepPending.current = false;
            // Copies made before Enter stopped carrying links are released too.
            for (const task of noteTasks(editor.state.doc)) if (task.blockId) relinked.current.add(task.blockId);
          }
          releaseCopiedLinks(editor, byId, noteId, relinked.current, dirty.current);
          repairLinks(editor, byId, { agreed: agreed.current, dirty: dirty.current, deletedHere: deletedHere.current });
          const tasks = noteTasks(editor.state.doc);
          const caretBlock = flush ? null : taskItemAtSelection(editor)?.node.attrs.id ?? null;
          const seen = new Set(tasks.map((task) => task.todoId).filter(isLinked));

          // Lines removed by the author take their TODOs with them.
          for (const todoId of [...removed.current]) {
            removed.current.delete(todoId);
            if (seen.has(todoId)) continue;
            const todo = byId.get(todoId);
            if (!todo || todo.targetKind !== 'library_item' || todo.targetId !== noteId) continue;
            agreed.current.delete(todoId);
            deletedHere.current.add(todoId);
            await usecases.deleteComment(todoId);
          }

          for (const task of tasks) {
            if (!task.blockId) continue;
            if (task.blockId === caretBlock) {
              // The line being written waits until the caret leaves it.
              if (sweep && task.todoId === null) dirty.current.add(task.blockId);
              continue;
            }
            const touched = dirty.current.has(task.blockId);
            if (!touched && !sweep) continue;
            dirty.current.delete(task.blockId);
            if (!task.text) continue;
            if (isLinked(task.todoId)) {
              const todo = linkedTodo(task.todoId, byId);
              if (touched && todo && extractTextFromCommentBody(todo.bodyJson).trim() !== task.text) {
                await usecases.updateCommentBody(todo.id, createPlainCommentDoc(task.text));
              }
              continue;
            }
            if (task.todoId === '' || !projecting) continue;
            await linkTask(editor, usecases, { projectId, noteId }, task, agreed.current);
          }
        } catch (error) {
          log.error('Failed to reconcile note TODOs:', error);
        }
      }),
    [editor, noteId, projectId, ready],
  );

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void reconcile({ flush: false });
    }, RECONCILE_DELAY_MS);
  }, [reconcile]);

  // Project the lines already in the note once its document is shown, and
  // again when the note's switch is turned on.
  useEffect(() => {
    if (!ready) return;
    if (taskTodos) sweepPending.current = true;
    schedule();
  }, [ready, schedule, taskTodos]);

  // TODO → note: status, and lines whose TODO was deleted here and undo
  // brought back.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const changed = repairLinks(editor, byId, {
      agreed: agreed.current,
      dirty: dirty.current,
      deletedHere: deletedHere.current,
    });
    if (changed) schedule();
  }, [comments, editor, schedule]);

  // Note → TODO: track the author's own edits; remote ones only refresh the
  // baseline. Checkbox toggles apply at once, the rest on reconcile.
  useEffect(() => {
    if (!editor) return;
    previous.current = snapshotTasks(noteTasks(editor.state.doc));
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      const tasks = noteTasks(editor.state.doc);
      const next = snapshotTasks(tasks);
      const authored = !transaction.getMeta(LINK_META) && !isRemote(transaction) && transaction.docChanged;
      if (authored) {
        const present = new Set(tasks.map((task) => task.todoId).filter(isLinked));
        for (const [blockId, before] of previous.current) {
          if (isLinked(before.todoId) && !present.has(before.todoId)) removed.current.add(before.todoId);
          const after = next.get(blockId);
          if (after && after.text !== before.text) dirty.current.add(blockId);
        }
        for (const blockId of next.keys()) if (!previous.current.has(blockId)) dirty.current.add(blockId);
        for (const task of tasks) {
          if (task.blockId && isLinked(task.todoId) && previous.current.get(task.blockId)?.todoId !== task.todoId) {
            relinked.current.add(task.blockId);
          }
        }
        // Ticking a linked line's checkbox resolves or reopens its TODO.
        const toggled = tasks.filter((task) => {
          const before = task.blockId ? previous.current.get(task.blockId) : undefined;
          return isLinked(task.todoId) && before?.todoId === task.todoId && before.checked !== task.checked;
        });
        const byId = toggled.length > 0 ? commentsById() : null;
        for (const task of toggled) {
          const todo = linkedTodo(task.todoId, byId!);
          if (!todo) continue;
          const status = task.checked ? 'resolved' : 'open';
          agreed.current.set(todo.id, status);
          if ((todo.status === 'resolved') === task.checked) continue;
          const usecases = latest.current.commentUsecases;
          const apply = status === 'resolved' ? usecases.resolveComment : usecases.reopenComment;
          void apply(todo.id).catch((error: unknown) => log.error('Failed to sync linked TODO:', error));
        }
        schedule();
      } else if (tasks.some((task) => isLinked(task.todoId) && deletedHere.current.has(task.todoId))) {
        // Undo arrives through the Yjs binding, like a remote change; a line
        // it restores still points at the TODO deleted with it.
        schedule();
      }
      previous.current = next;
    };
    const onSelection = () => {
      // Leaving a touched line finishes it.
      if (dirty.current.size > 0) schedule();
    };
    const onBlur = () => void reconcile({ flush: true });
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onSelection);
    editor.on('blur', onBlur);
    return () => {
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onSelection);
      editor.off('blur', onBlur);
    };
  }, [editor, reconcile, schedule]);

  // Closing the note finishes whatever line was in progress.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void reconcile({ flush: true });
    },
    [reconcile],
  );

  /** Turns the task item at the selection into a TODO about this note. */
  const promoteTaskItem = useCallback(async () => {
    if (!editor) return;
    const found = taskItemAtSelection(editor);
    if (!found || hasLinkedTodo(found.node.attrs.todoId as string | null, useDataStore.getState().comments)) return;
    const task = noteTasks(editor.state.doc).find((candidate) => candidate.pos === found.pos);
    if (!task?.text || !task.blockId) return;
    await linkTask(editor, commentUsecases, { projectId, noteId }, task, agreed.current);
  }, [commentUsecases, editor, noteId, projectId]);

  /** Keeps the item at the selection as a plain checkbox and drops its TODO. */
  const unlinkTaskItem = useCallback(async () => {
    if (!editor) return;
    const found = taskItemAtSelection(editor);
    const todoId = found?.node.attrs.todoId as string | null | undefined;
    if (!found || !isLinked(todoId ?? null)) return;
    agreed.current.delete(todoId!);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, todoId: '' }).setMeta(LINK_META, true),
    );
    // The line is unlinked first, so deleting the TODO leaves it in place.
    await Promise.resolve();
    if (useDataStore.getState().comments.some((comment) => comment.id === todoId)) {
      await commentUsecases.deleteComment(todoId!);
    }
  }, [commentUsecases, editor]);

  return { promoteTaskItem, unlinkTaskItem };
}

/**
 * A TODO belongs to the line it is anchored to. A line the author's edit gave
 * someone else's link (a pasted copy, from this note or another) is unlinked
 * and projected as a TODO of its own. A copy whose original is gone keeps the
 * link, so the TODO is not left without a line. Exported for tests.
 */
export function releaseCopiedLinks(
  editor: Editor,
  byId: ReadonlyMap<string, Comment>,
  noteId: string,
  relinked: Set<string>,
  dirty: Set<string>,
): boolean {
  if (relinked.size === 0) return false;
  const tasks = noteTasks(editor.state.doc);
  const holders = new Set(tasks.map((task) => `${task.todoId}\u0000${task.blockId}`));
  const tr = editor.state.tr;
  let changed = false;
  for (const task of tasks) {
    if (!task.blockId || !relinked.has(task.blockId)) continue;
    const todo = linkedTodo(task.todoId, byId);
    if (!todo || (todo.targetId === noteId && todo.targetBlockId === task.blockId)) continue;
    const originalHere = todo.targetId === noteId && holders.has(`${todo.id}\u0000${todo.targetBlockId}`);
    if (todo.targetId === noteId && !originalHere) continue;
    tr.setNodeMarkup(task.pos, undefined, { ...task.node.attrs, todoId: null });
    dirty.add(task.blockId);
    changed = true;
  }
  relinked.clear();
  if (changed) editor.view.dispatch(tr.setMeta(LINK_META, true).setMeta('addToHistory', false));
  return changed;
}

/**
 * TODO → note: moves checkboxes to their TODO's status. A line whose TODO was
 * deleted here and that undo brought back is projected again; any other link
 * to a TODO this device lacks is left alone (the line acts as a plain
 * checkbox until the TODO arrives). Returns whether the document changed.
 * Exported for tests.
 */
export function repairLinks(
  editor: Editor,
  byId: ReadonlyMap<string, Comment>,
  state: { agreed: Map<string, 'open' | 'resolved'>; dirty: Set<string>; deletedHere: Set<string> },
): boolean {
  const tr = editor.state.tr;
  let changed = false;
  for (const task of noteTasks(editor.state.doc)) {
    if (!isLinked(task.todoId)) continue;
    const todo = linkedTodo(task.todoId, byId);
    if (!todo) {
      state.agreed.delete(task.todoId);
      if (!state.deletedHere.delete(task.todoId)) continue;
      tr.setNodeMarkup(task.pos, undefined, { ...task.node.attrs, todoId: null });
      if (task.blockId) state.dirty.add(task.blockId);
      changed = true;
      continue;
    }
    const status = todo.status === 'resolved' ? 'resolved' : 'open';
    if (state.agreed.get(task.todoId) !== status && task.checked !== (status === 'resolved')) {
      tr.setNodeMarkup(task.pos, undefined, { ...task.node.attrs, checked: status === 'resolved' });
      changed = true;
    }
    state.agreed.set(task.todoId, status);
  }
  if (changed) editor.view.dispatch(tr.setMeta(LINK_META, true).setMeta('addToHistory', false));
  return changed;
}

/**
 * Makes the line a TODO about the note and links it. A line still pointing at
 * a TODO this device lacks gets a new one. Exported for tests.
 */
export async function linkTask(
  editor: Editor,
  usecases: Pick<ReturnType<typeof useComment>, 'createComment' | 'resolveComment' | 'deleteComment'>,
  note: { projectId: string; noteId: string },
  task: NoteTask,
  agreed: Map<string, 'open' | 'resolved'>,
): Promise<void> {
  if (!task.blockId) return;
  const created = await usecases.createComment(noteTaskTodoInput(note.noteId, task.blockId, task.text));
  const status = task.checked ? 'resolved' : 'open';
  if (status === 'resolved') await usecases.resolveComment(created.id);
  agreed.set(created.id, status);
  const drop = async () => {
    // The line went away (or got linked, or unlinked) meanwhile; the TODO has
    // no line.
    agreed.delete(created.id);
    await usecases.deleteComment(created.id);
  };
  if (editor.isDestroyed) {
    // The note closed while saving (closing finishes the line in progress):
    // link the line in its document, or the next open would project it again.
    const linked = await linkNoteTaskLine(note.projectId, note.noteId, task.blockId, created.id, task.todoId);
    if (!linked) await drop();
    return;
  }
  // The document may have changed while saving; find the line again.
  const position = taskPosition(editor, task.blockId);
  const node = position === null ? null : editor.state.doc.nodeAt(position);
  if (position === null || node?.type.name !== 'taskItem' || (node.attrs.todoId ?? null) !== task.todoId) {
    await drop();
    return;
  }
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(position, undefined, { ...node.attrs, todoId: created.id })
      .setMeta(LINK_META, true)
      .setMeta('addToHistory', false),
  );
}
