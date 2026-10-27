import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import loglevel from 'loglevel';

import { useDataStore } from '../store/data-store';
import { useComment } from '../usecase/useComment';
import {
  createPlainCommentDoc,
  extractTextFromCommentBody,
  NOTE_TASK_TODO_METADATA,
  type Comment,
} from '../domain/comment';

const log = loglevel.getLogger('note-todo-links');
log.setLevel(loglevel.levels.ERROR);

/** Marks transactions this module makes, so they are not read as author edits. */
const LINK_META = 'noteTodoLink';
/** Quiet time after the last edit before the checklist is reconciled. */
const RECONCILE_DELAY_MS = 1200;

// A task item's `todoId`: a string links it to that TODO, '' keeps it a plain
// checkbox (the author unlinked it, or its TODO went away), null means it was
// never linked and is projected once the author finishes the line.

interface NoteTask {
  pos: number;
  node: PMNode;
  blockId: string | null;
  todoId: string | null;
  checked: boolean;
  text: string;
}

function ownText(node: PMNode): string {
  let text = '';
  node.forEach((child) => {
    if (child.type.name !== 'taskList') text += child.textContent;
  });
  return text.trim();
}

function noteTasks(doc: PMNode): NoteTask[] {
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
 * edits arriving from other devices were reconciled where they were made.
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
  // Lines already in the note are projected once, when it is first shown.
  const sweepPending = useRef(true);
  const previous = useRef(new Map<string, { text: string; todoId: string | null }>());
  const reconciling = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ comments, commentUsecases, taskTodos });
  useEffect(() => {
    latest.current = { comments, commentUsecases, taskTodos };
  }, [commentUsecases, comments, taskTodos]);

  const reconcile = useCallback(
    async ({ flush }: { flush: boolean }) => {
      if (!editor || editor.isDestroyed || reconciling.current) return;
      reconciling.current = true;
      try {
        const { commentUsecases: usecases, taskTodos: projecting } = latest.current;
        const byId = new Map(useDataStore.getState().comments.map((comment) => [comment.id, comment]));
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

        const sweep = sweepPending.current && ready;
        if (sweep) sweepPending.current = false;
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
            const todo = byId.get(task.todoId);
            if (touched && todo && extractTextFromCommentBody(todo.bodyJson).trim() !== task.text) {
              await usecases.updateCommentBody(todo.id, createPlainCommentDoc(task.text));
            }
            continue;
          }
          if (task.todoId === '' || !projecting) continue;
          await linkTask(editor, usecases, noteId, task, agreed.current);
        }
      } catch (error) {
        log.error('Failed to reconcile note TODOs:', error);
      } finally {
        reconciling.current = false;
      }
    },
    [editor, noteId, ready],
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

  // TODO → note: status, and links to TODOs that no longer exist.
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
    previous.current = new Map(
      noteTasks(editor.state.doc)
        .filter((task) => task.blockId)
        .map((task) => [task.blockId!, { text: task.text, todoId: task.todoId }]),
    );
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      const tasks = noteTasks(editor.state.doc);
      const next = new Map(
        tasks.filter((task) => task.blockId).map((task) => [task.blockId!, { text: task.text, todoId: task.todoId }]),
      );
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
          if (!isLinked(task.todoId)) continue;
          const status = task.checked ? 'resolved' : 'open';
          const before = agreed.current.get(task.todoId);
          if (!before || before === status) continue;
          agreed.current.set(task.todoId, status);
          const usecases = latest.current.commentUsecases;
          const apply = status === 'resolved' ? usecases.resolveComment : usecases.reopenComment;
          void apply(task.todoId).catch((error: unknown) => log.error('Failed to sync linked TODO:', error));
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
    if (!found || isLinked(found.node.attrs.todoId as string | null)) return;
    const task = noteTasks(editor.state.doc).find((candidate) => candidate.pos === found.pos);
    if (!task?.text || !task.blockId) return;
    await linkTask(editor, commentUsecases, noteId, task, agreed.current);
  }, [commentUsecases, editor, noteId]);

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
 * TODO → note: moves checkboxes to their TODO's status, and repairs links to
 * TODOs that no longer exist. Undoing a removed line restores a link to the
 * TODO deleted with it; that line is projected again. Any other dangling link
 * becomes a plain checkbox. Returns whether the document changed.
 */
function repairLinks(
  editor: Editor,
  byId: ReadonlyMap<string, Comment>,
  state: { agreed: Map<string, 'open' | 'resolved'>; dirty: Set<string>; deletedHere: Set<string> },
): boolean {
  const tr = editor.state.tr;
  let changed = false;
  for (const task of noteTasks(editor.state.doc)) {
    if (!isLinked(task.todoId)) continue;
    const todo = byId.get(task.todoId);
    if (!todo || todo.kind !== 'todo') {
      const restored = state.deletedHere.delete(task.todoId);
      tr.setNodeMarkup(task.pos, undefined, { ...task.node.attrs, todoId: restored ? null : '' });
      if (restored && task.blockId) state.dirty.add(task.blockId);
      state.agreed.delete(task.todoId);
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

async function linkTask(
  editor: Editor,
  usecases: ReturnType<typeof useComment>,
  noteId: string,
  task: NoteTask,
  agreed: Map<string, 'open' | 'resolved'>,
): Promise<void> {
  if (!task.blockId) return;
  const created = await usecases.createComment({
    kind: 'todo',
    targetKind: 'library_item',
    targetId: noteId,
    targetBlockId: task.blockId,
    targetBlockIds: [task.blockId],
    anchorJson: JSON.stringify({ createdAt: new Date().toISOString() }),
    bodyJson: createPlainCommentDoc(task.text),
    metadataJson: NOTE_TASK_TODO_METADATA,
  });
  const status = task.checked ? 'resolved' : 'open';
  if (status === 'resolved') await usecases.resolveComment(created.id);
  agreed.set(created.id, status);
  // The document may have changed while saving; find the line again.
  if (editor.isDestroyed) return;
  const position = taskPosition(editor, task.blockId);
  const node = position === null ? null : editor.state.doc.nodeAt(position);
  if (position === null || node?.type.name !== 'taskItem' || isLinked(node.attrs.todoId as string | null)) {
    // The line went away (or got linked) meanwhile; the TODO has no line.
    agreed.delete(created.id);
    await usecases.deleteComment(created.id);
    return;
  }
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(position, undefined, { ...node.attrs, todoId: created.id })
      .setMeta(LINK_META, true)
      .setMeta('addToHistory', false),
  );
}
