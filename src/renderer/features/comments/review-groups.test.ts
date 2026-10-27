import { describe, expect, it } from 'vitest';

import type { Comment } from '../../domain/comment';
import type { LibraryItem } from '../../domain/library-item';
import { noteTaskItems } from '../../lib/note-tasks';
import { blockOrder, groupReviewItems, reviewGroupTitle, type ReviewGroupData } from './review-groups';

function comment(id: string, patch: Partial<Comment>): Comment {
  return {
    id,
    projectId: 'p',
    kind: 'todo',
    targetKind: null,
    targetId: null,
    targetBlockId: null,
    anchorJson: '{}',
    authorKind: 'user',
    authorId: null,
    authorName: null,
    bodyJson: '{}',
    status: 'open',
    priority: null,
    source: 'manual',
    metadataJson: null,
    targetBlockIdsJson: '[]',
    resolvedAt: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    ...patch,
  };
}

const noteBody = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'h1', level: 2 }, content: [{ type: 'text', text: '潮汐' }] },
    {
      type: 'taskList',
      attrs: { id: 'list' },
      content: [
        {
          type: 'taskItem',
          attrs: { id: 'task-a', checked: true, todoId: 'todo-a' },
          content: [
            { type: 'paragraph', attrs: { id: 'pa' }, content: [{ type: 'text', text: '找潮汐表' }] },
            {
              type: 'taskList',
              attrs: { id: 'nested' },
              content: [
                {
                  type: 'taskItem',
                  attrs: { id: 'task-b', checked: false, todoId: null },
                  content: [{ type: 'paragraph', attrs: { id: 'pb' }, content: [{ type: 'text', text: '核对年份' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const note = {
  id: 'note',
  projectId: 'p',
  kind: 'text',
  title: '调研',
  bodyJson: noteBody,
} as LibraryItem;

const data: ReviewGroupData = {
  bookNodes: [{ id: 'chapter', title: '第一章', kind: 'chapter' }] as ReviewGroupData['bookNodes'],
  bookElements: [],
  storylines: [],
  bookElementCategories: [],
  libraryItems: [note],
};

describe('review groups', () => {
  it('groups by target, newest group first, floating items last', () => {
    const items = [
      comment('c1', { targetKind: 'node', targetId: 'chapter' }),
      comment('f1', {}),
      comment('n1', { targetKind: 'library_item', targetId: 'note' }),
      comment('c2', { targetKind: 'node', targetId: 'chapter' }),
    ];
    const groups = groupReviewItems(items, data);
    expect(groups.map((group) => group.key)).toEqual(['node:chapter', 'library_item:note', 'floating']);
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['c1', 'c2']);
  });

  it('orders a note group by document position, unanchored items after', () => {
    const items = [
      comment('loose', { targetKind: 'library_item', targetId: 'note' }),
      comment('b', { targetKind: 'library_item', targetId: 'note', targetBlockId: 'task-b' }),
      comment('a', { targetKind: 'library_item', targetId: 'note', targetBlockId: 'task-a' }),
      comment('head', { targetKind: 'library_item', targetId: 'note', targetBlockId: 'h1' }),
    ];
    const [group] = groupReviewItems(items, data);
    expect(group!.items.map((item) => item.id)).toEqual(['head', 'a', 'b', 'loose']);
  });

  it('names targets and reports deleted ones', () => {
    expect(reviewGroupTitle(data, 'library_item', 'note')).toEqual({ title: '调研', isDrift: false });
    expect(reviewGroupTitle(data, 'node', 'chapter')).toEqual({ title: '第一章', isDrift: false });
    expect(reviewGroupTitle(data, 'element', 'gone')).toBeNull();
  });

  it('reads block order through nested blocks', () => {
    expect([...blockOrder(noteBody).keys()]).toEqual(['h1', 'list', 'task-a', 'pa', 'nested', 'task-b', 'pb']);
    expect(blockOrder('not json').size).toBe(0);
  });
});

describe('note task items', () => {
  it('lists tasks in document order with their own text only', () => {
    expect(noteTaskItems(noteBody)).toEqual([
      { blockId: 'task-a', todoId: 'todo-a', checked: true, text: '找潮汐表' },
      { blockId: 'task-b', todoId: null, checked: false, text: '核对年份' },
    ]);
    expect(noteTaskItems(null)).toEqual([]);
  });
});
