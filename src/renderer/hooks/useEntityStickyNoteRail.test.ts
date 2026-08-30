import { describe, expect, it } from 'vitest';

import {
  addCommentToStickyNoteRail,
  commentStickyNoteRailTarget,
  removeCommentFromStickyNoteRail,
  stickyNoteRailSnapshot,
} from './useEntityStickyNoteRail';
import { events } from '../lib/events';

describe('sticky-note rail session registry', () => {
  it('places new notes at the top without duplicating membership', () => {
    addCommentToStickyNoteRail('node', 'rail-order', 'comment-a');
    addCommentToStickyNoteRail('node', 'rail-order', 'comment-b');
    addCommentToStickyNoteRail('node', 'rail-order', 'comment-a');

    expect(stickyNoteRailSnapshot('node', 'rail-order')).toMatchObject({
      visible: true,
      itemIds: ['comment-a', 'comment-b'],
    });
  });

  it('removes explicit membership without changing another editor rail', () => {
    addCommentToStickyNoteRail('node', 'rail-one', 'shared-comment');
    addCommentToStickyNoteRail('element', 'rail-two', 'other-comment');
    removeCommentFromStickyNoteRail('node', 'rail-one', 'shared-comment');

    expect(stickyNoteRailSnapshot('node', 'rail-one').itemIds).toEqual([]);
    expect(stickyNoteRailSnapshot('element', 'rail-two').itemIds).toEqual(['other-comment']);
  });

  it('can clean deleted item membership from every rail', () => {
    addCommentToStickyNoteRail('storyline', 'rail-three', 'deleted-comment');
    expect(commentStickyNoteRailTarget('deleted-comment')).toEqual({
      kind: 'storyline',
      id: 'rail-three',
    });

    events.emit('comment:deleted', { commentId: 'deleted-comment' });
    expect(commentStickyNoteRailTarget('deleted-comment')).toBeNull();
  });

  it('moves one review item instead of duplicating it across editor rails', () => {
    addCommentToStickyNoteRail('node', 'rail-origin', 'moving-comment');
    addCommentToStickyNoteRail('category', 'rail-destination', 'moving-comment');

    expect(stickyNoteRailSnapshot('node', 'rail-origin').itemIds).toEqual([]);
    expect(stickyNoteRailSnapshot('category', 'rail-destination').itemIds).toEqual([
      'moving-comment',
    ]);
  });
});
