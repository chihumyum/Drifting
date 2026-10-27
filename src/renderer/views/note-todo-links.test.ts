import type { Editor } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';

import type { Comment } from '../domain/comment';
import { schemaForProfile } from '../lib/editor-schema-profile';
import { linkNoteTaskLine } from '../lib/note-task-document';
import { linkTask, noteTasks, releaseCopiedLinks, repairLinks, runSerially } from './note-todo-links';

vi.mock('../lib/note-task-document', () => ({ linkNoteTaskLine: vi.fn(async () => true) }));

const note = { projectId: 'project', noteId: 'note' };

function taskItem(id: string, todoId: string | null, text: string, checked = false) {
  return {
    type: 'taskItem',
    attrs: { id, todoId, checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** The editor surface these helpers use: state, dispatch, isDestroyed. */
function noteEditor(...items: ReturnType<typeof taskItem>[]) {
  const schema = schemaForProfile('note');
  let state = EditorState.create({
    doc: schema.nodeFromJSON({ type: 'doc', content: [{ type: 'taskList', content: items }] }),
  });
  const editor = {
    get state() {
      return state;
    },
    isDestroyed: false as boolean,
    view: {
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    },
  };
  return editor as unknown as Editor;
}

function todo(id: string, status: 'open' | 'resolved' = 'open'): Comment {
  return { id, kind: 'todo', status } as Comment;
}

const linkState = () => ({
  agreed: new Map<string, 'open' | 'resolved'>(),
  dirty: new Set<string>(),
  deletedHere: new Set<string>(),
});

describe('note checklist links', () => {
  it('keeps a link to a TODO this device lacks, and mirrors it once it arrives', () => {
    const editor = noteEditor(taskItem('a', 'todo-a', '找潮汐表'));
    const state = linkState();

    // The line synced before its TODO row: nothing is rewritten.
    expect(repairLinks(editor, new Map(), state)).toBe(false);
    expect(noteTasks(editor.state.doc)[0]).toMatchObject({ todoId: 'todo-a', checked: false });

    // The TODO arrives, already resolved on the other device.
    expect(repairLinks(editor, new Map([['todo-a', todo('todo-a', 'resolved')]]), state)).toBe(true);
    expect(noteTasks(editor.state.doc)[0]).toMatchObject({ todoId: 'todo-a', checked: true });
    expect(state.agreed.get('todo-a')).toBe('resolved');
  });

  it('projects a line again when undo brings it back after its TODO was deleted here', () => {
    const editor = noteEditor(taskItem('a', 'todo-a', '找潮汐表'));
    const state = linkState();
    state.deletedHere.add('todo-a');

    expect(repairLinks(editor, new Map(), state)).toBe(true);
    expect(noteTasks(editor.state.doc)[0]?.todoId).toBeNull();
    expect(state.dirty.has('a')).toBe(true);
    expect(state.deletedHere.size).toBe(0);
  });

  it('releases pasted copies of linked lines; a lone copy whose original is gone keeps its link', () => {
    const editor = noteEditor(
      taskItem('a', 'todo-a', '找潮汐表'),
      taskItem('b', 'todo-a', '找潮汐表'),
      taskItem('c', 'todo-x', '别的笔记里的行'),
      taskItem('d', 'todo-m', '原行已不在'),
      taskItem('e', 'todo-late', '还在同步'),
    );
    const anchored = (id: string, targetId: string, targetBlockId: string) =>
      ({ ...todo(id), targetId, targetBlockId }) as Comment;
    const byId = new Map([
      ['todo-a', anchored('todo-a', 'note', 'a')],
      ['todo-x', anchored('todo-x', 'other-note', 'x')],
      ['todo-m', anchored('todo-m', 'note', 'gone')],
    ]);
    const dirty = new Set<string>();
    const relinked = new Set(['a', 'b', 'c', 'd', 'e']);

    expect(releaseCopiedLinks(editor, byId, 'note', relinked, dirty)).toBe(true);
    expect(noteTasks(editor.state.doc).map((task) => task.todoId)).toEqual(['todo-a', null, null, 'todo-m', 'todo-late']);
    expect([...dirty].sort()).toEqual(['b', 'c']);
    expect(relinked.size).toBe(0);
  });

  it('gives a line pointing at a missing TODO a new one', async () => {
    const editor = noteEditor(taskItem('a', 'gone', '查年代', true));
    const usecases = {
      createComment: vi.fn(async () => ({ id: 'todo-new' }) as Comment),
      resolveComment: vi.fn(async () => undefined),
      deleteComment: vi.fn(async () => undefined),
    };
    const agreed = new Map<string, 'open' | 'resolved'>();

    await linkTask(editor, usecases as never, note, noteTasks(editor.state.doc)[0]!, agreed);

    expect(usecases.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'todo', targetKind: 'library_item', targetId: 'note', targetBlockId: 'a' }),
    );
    expect(usecases.resolveComment).toHaveBeenCalledWith('todo-new');
    expect(usecases.deleteComment).not.toHaveBeenCalled();
    expect(noteTasks(editor.state.doc)[0]?.todoId).toBe('todo-new');
    expect(agreed.get('todo-new')).toBe('resolved');
  });

  it('drops the new TODO when the line got another link while it was saving', async () => {
    const editor = noteEditor(taskItem('a', null, '查年代'));
    const usecases = {
      createComment: vi.fn(async () => {
        const [task] = noteTasks(editor.state.doc);
        editor.view.dispatch(editor.state.tr.setNodeMarkup(task!.pos, undefined, { ...task!.node.attrs, todoId: 'other' }));
        return { id: 'todo-new' } as Comment;
      }),
      resolveComment: vi.fn(async () => undefined),
      deleteComment: vi.fn(async () => undefined),
    };

    await linkTask(editor, usecases as never, note, noteTasks(editor.state.doc)[0]!, new Map());

    expect(usecases.deleteComment).toHaveBeenCalledWith('todo-new');
    expect(noteTasks(editor.state.doc)[0]?.todoId).toBe('other');
  });

  it('links the line in the note\'s document when the tab closed while the TODO was saving', async () => {
    const editor = noteEditor(taskItem('a', null, '查年代'));
    const task = noteTasks(editor.state.doc)[0]!;
    const usecases = {
      createComment: vi.fn(async () => {
        (editor as unknown as { isDestroyed: boolean }).isDestroyed = true;
        return { id: 'todo-new' } as Comment;
      }),
      resolveComment: vi.fn(async () => undefined),
      deleteComment: vi.fn(async () => undefined),
    };

    await linkTask(editor, usecases as never, note, task, new Map());
    expect(linkNoteTaskLine).toHaveBeenCalledWith('project', 'note', 'a', 'todo-new', null);
    expect(usecases.deleteComment).not.toHaveBeenCalled();

    // The line changed before the document could be linked: no TODO is left over.
    vi.mocked(linkNoteTaskLine).mockResolvedValueOnce(false);
    (editor as unknown as { isDestroyed: boolean }).isDestroyed = false;
    await linkTask(editor, usecases as never, note, task, new Map());
    expect(usecases.deleteComment).toHaveBeenCalledWith('todo-new');
  });

  it('runs a reconcile requested during another once that one ends, a flush winning', async () => {
    const queue = { running: false, queued: null };
    const calls: boolean[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async ({ flush }: { flush: boolean }) => {
      calls.push(flush);
      if (calls.length === 1) await first;
    });

    const running = runSerially(queue, { flush: false }, run);
    await runSerially(queue, { flush: false }, run);
    await runSerially(queue, { flush: true }, run);
    expect(calls).toEqual([false]);

    release();
    await running;
    expect(calls).toEqual([false, true]);
    expect(queue).toEqual({ running: false, queued: null });
  });
});
