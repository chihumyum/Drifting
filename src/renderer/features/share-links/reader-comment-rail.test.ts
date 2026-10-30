import { afterEach, describe, expect, it } from 'vitest';
import type { Comment } from '../../domain/comment';
import { removeCommentFromStickyNoteRail, stickyNoteRailSnapshot } from '../../hooks/useEntityStickyNoteRail';
import { useDataStore } from '../../store/data-store';
import { installReaderCommentRail } from './reader-comment-rail';

const comment = (id: string, patch: Partial<Comment> = {}): Comment => ({
  id,
  projectId: 'project',
  kind: 'note',
  targetKind: 'node',
  targetId: 'chapter',
  targetBlockId: null,
  anchorJson: '{}',
  authorKind: 'external',
  authorId: null,
  authorName: '合成读者',
  bodyJson: '{}',
  status: 'open',
  priority: null,
  source: 'api',
  metadataJson: JSON.stringify({ shareLink: { shareId: 'share' } }),
  targetBlockIdsJson: '[]',
  resolvedAt: null,
  createdAt: `2026-10-30T00:00:0${id.length % 10}.000Z`,
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...patch,
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  useDataStore.getState().setComments([]);
});

describe('reader comments on the sticky-note rail', () => {
  it('pins open reader comments of the project, newest on top, and leaves others alone', () => {
    useDataStore.getState().setComments([
      comment('old', { createdAt: '2026-10-30T00:00:01.000Z' }),
      comment('new', { createdAt: '2026-10-30T00:00:02.000Z' }),
      comment('mine', { authorKind: 'user', metadataJson: null }),
      comment('done', { status: 'resolved' }),
      comment('elsewhere', { projectId: 'other' }),
      comment('element-note', { targetKind: 'element', targetId: 'lin' }),
    ]);
    stops.push(installReaderCommentRail('project'));
    expect(stickyNoteRailSnapshot('node', 'chapter')).toMatchObject({ visible: true, itemIds: ['new', 'old'] });
    expect(stickyNoteRailSnapshot('element', 'lin').itemIds).toEqual(['element-note']);
  });

  it('pins a comment that arrives later, but not one the author took off the rail', () => {
    stops.push(installReaderCommentRail('project'));
    useDataStore.getState().setComments([comment('first')]);
    expect(stickyNoteRailSnapshot('node', 'chapter').itemIds).toContain('first');
    removeCommentFromStickyNoteRail('node', 'chapter', 'first');
    useDataStore.getState().setComments([comment('first'), comment('second')]);
    expect(stickyNoteRailSnapshot('node', 'chapter').itemIds).toContain('second');
    expect(stickyNoteRailSnapshot('node', 'chapter').itemIds).not.toContain('first');
  });
});
