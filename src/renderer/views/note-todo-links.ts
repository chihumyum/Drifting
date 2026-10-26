import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import loglevel from 'loglevel';

import { useDataStore } from '../store/data-store';
import { useComment } from '../usecase/useComment';
import { createPlainCommentDoc } from '../domain/comment';

const log = loglevel.getLogger('note-todo-links');
log.setLevel(loglevel.levels.ERROR);

/** Marks transactions this module makes, so they are not read as author toggles. */
const LINK_META = 'noteTodoLink';

interface LinkedTaskItem {
  pos: number;
  node: PMNode;
  todoId: string;
  checked: boolean;
}

function linkedTaskItems(doc: PMNode): LinkedTaskItem[] {
  const items: LinkedTaskItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && typeof node.attrs.todoId === 'string') {
      items.push({ pos, node, todoId: node.attrs.todoId, checked: Boolean(node.attrs.checked) });
    }
  });
  return items;
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

/**
 * Keeps a note's linked task items and their TODOs agreeing. The TODO is the
 * authority: a TODO resolved or reopened elsewhere (the TODO rail, the Review
 * panel, another device) moves the checkbox; ticking a linked checkbox in the
 * note resolves or reopens the TODO. Deleting the TODO unlinks the item.
 */
export function useNoteTodoLinks({
  editor,
  noteId,
  projectId,
  userId,
}: {
  editor: Editor | null;
  noteId: string;
  projectId: string;
  userId: string;
}) {
  const comments = useDataStore((state) => state.comments);
  const commentUsecases = useComment({ projectId, userId });
  // Last status this note agreed on, per TODO; tells which side changed.
  const agreed = useRef(new Map<string, 'open' | 'resolved'>());

  // TODO → note.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tr = editor.state.tr;
    let changed = false;
    for (const item of linkedTaskItems(editor.state.doc)) {
      const todo = comments.find((comment) => comment.id === item.todoId);
      if (!todo || todo.kind !== 'todo') {
        tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, todoId: null });
        agreed.current.delete(item.todoId);
        changed = true;
        continue;
      }
      const status = todo.status === 'resolved' ? 'resolved' : 'open';
      if (agreed.current.get(item.todoId) !== status && item.checked !== (status === 'resolved')) {
        tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: status === 'resolved' });
        changed = true;
      }
      agreed.current.set(item.todoId, status);
    }
    if (changed) editor.view.dispatch(tr.setMeta(LINK_META, true));
  }, [comments, editor]);

  // Note → TODO: only the author's own checkbox toggles, never remote edits.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.getMeta(LINK_META)) return;
      const remote = transaction.getMeta('y-sync$') as { isChangeOrigin?: boolean } | undefined;
      if (remote?.isChangeOrigin) return;
      for (const item of linkedTaskItems(editor.state.doc)) {
        const status = item.checked ? 'resolved' : 'open';
        const previous = agreed.current.get(item.todoId);
        if (!previous || previous === status) continue;
        agreed.current.set(item.todoId, status);
        const apply = status === 'resolved' ? commentUsecases.resolveComment : commentUsecases.reopenComment;
        void apply(item.todoId).catch((error: unknown) => log.error('Failed to sync linked TODO:', error));
      }
    };
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [commentUsecases, editor]);

  /** Turns the task item at the selection into a TODO about this note. */
  const promoteTaskItem = useCallback(async () => {
    if (!editor) return;
    const found = taskItemAtSelection(editor);
    if (!found || typeof found.node.attrs.todoId === 'string') return;
    const text = found.node.textContent.trim();
    if (!text) return;
    const blockId = typeof found.node.attrs.id === 'string' ? found.node.attrs.id : null;
    const created = await commentUsecases.createComment({
      kind: 'todo',
      targetKind: 'library_item',
      targetId: noteId,
      targetBlockId: blockId,
      anchorJson: JSON.stringify({ selectedText: text, createdAt: new Date().toISOString() }),
      bodyJson: createPlainCommentDoc(text),
    });
    const status = found.node.attrs.checked ? 'resolved' : 'open';
    if (status === 'resolved') await commentUsecases.resolveComment(created.id);
    agreed.current.set(created.id, status);
    // Re-resolve the position: the document may have changed while saving.
    const current = linkedPosition(editor, blockId) ?? found.pos;
    const node = editor.state.doc.nodeAt(current);
    if (node?.type.name !== 'taskItem') return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(current, undefined, { ...node.attrs, todoId: created.id }).setMeta(LINK_META, true),
    );
  }, [commentUsecases, editor, noteId]);

  /** Unlinks the item at the selection; the TODO itself stays. */
  const unlinkTaskItem = useCallback(() => {
    if (!editor) return;
    const found = taskItemAtSelection(editor);
    if (!found || typeof found.node.attrs.todoId !== 'string') return;
    agreed.current.delete(found.node.attrs.todoId);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, todoId: null }).setMeta(LINK_META, true),
    );
  }, [editor]);

  return { promoteTaskItem, unlinkTaskItem };
}

function linkedPosition(editor: Editor, blockId: string | null): number | null {
  if (!blockId) return null;
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'taskItem' && node.attrs.id === blockId) found = pos;
    return undefined;
  });
  return found;
}
