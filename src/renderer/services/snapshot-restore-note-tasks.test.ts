import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Comment } from '../domain/comment';
import { NOTE_TASK_TODO_METADATA } from '../domain/comment';
import type { LibraryItem } from '../domain/library-item';
import type { AgentToolContext } from '../lib/agent/tool-handlers';
import { setNoteTaskLinks } from '../lib/note-task-document';
import type { EntitySnapshotRow } from '../sqlite-repo/entity-snapshot-repo';
import { useDataStore } from '../store/data-store';
import { settleRestoredNoteTasks } from './snapshot-restore.service';

vi.mock('../lib/note-task-document', () => ({
  readNoteTaskLinks: vi.fn(),
  setNoteTaskLinks: vi.fn(async () => 'relinked'),
}));
vi.mock('../lib/yjs-doc-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/yjs-doc-registry')>()),
  // The note is open: it has a document to relink.
  getLiveYDoc: () => ({}),
}));

const noteTask = (id: string, targetId = 'note') =>
  ({ id, kind: 'todo', status: 'open', targetKind: 'library_item', targetId, metadataJson: NOTE_TASK_TODO_METADATA }) as Comment;

function taskItem(id: string, todoId: string, text: string, checked = false) {
  return { type: 'taskItem', attrs: { id, todoId, checked }, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

// The restored version: one line still has its TODO, one lost it, one lost it
// and is empty, one is a plain checkbox.
const restoredBody = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: [
        taskItem('a', 'todo-a', '找潮汐表'),
        taskItem('b', 'todo-gone', '查年代', true),
        taskItem('c', 'todo-gone-2', ''),
        taskItem('d', '', '散记'),
      ],
    },
  ],
});

function context() {
  const write = {
    deleteComment: vi.fn(async () => undefined),
    createComment: vi.fn(async () => ({ id: 'todo-new' })),
    resolveComment: vi.fn(async () => undefined),
  };
  return { ctx: { write } as unknown as AgentToolContext, write };
}

const row = { projectId: 'project', entityId: 'note', entityKind: 'library_item' } as EntitySnapshotRow;

afterEach(() => {
  vi.clearAllMocks();
  useDataStore.getState().setComments([]);
  useDataStore.getState().setLibraryItems([]);
});

describe('restoring a note version', () => {
  it('deletes TODOs whose lines it removed and gives restored lines new ones', async () => {
    useDataStore.getState().setComments([noteTask('todo-a'), noteTask('todo-removed'), noteTask('todo-elsewhere', 'other-note')]);
    const { ctx, write } = context();

    const body = await settleRestoredNoteTasks(
      ctx,
      row,
      new Set(['todo-a', 'todo-removed', 'todo-elsewhere']),
      restoredBody,
    );

    expect(write.deleteComment.mock.calls).toEqual([['todo-removed']]);
    expect(write.createComment).toHaveBeenCalledTimes(1);
    expect(write.createComment).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'note', targetBlockId: 'b' }));
    expect(write.resolveComment).toHaveBeenCalledWith('todo-new');
    expect(setNoteTaskLinks).toHaveBeenCalledWith('project', 'note', new Map([['b', 'todo-new'], ['c', null]]));
    expect(body).toBe('relinked');
  });

  it('leaves restored lines for projection while the note\'s switch is off', async () => {
    useDataStore.getState().setComments([noteTask('todo-a')]);
    useDataStore.getState().setLibraryItems([{ id: 'note', taskTodos: false } as LibraryItem]);
    const { ctx, write } = context();

    await settleRestoredNoteTasks(ctx, row, new Set(['todo-a']), restoredBody);

    expect(write.createComment).not.toHaveBeenCalled();
    expect(write.deleteComment).not.toHaveBeenCalled();
    expect(setNoteTaskLinks).toHaveBeenCalledWith('project', 'note', new Map([['b', null], ['c', null]]));
  });
});
