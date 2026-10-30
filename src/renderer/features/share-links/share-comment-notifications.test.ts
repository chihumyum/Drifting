import { afterEach, describe, expect, it } from 'vitest';
import { i18next } from '../../lib/i18n';
import { useNotificationStore } from '../../store/notification-store';
import { notifyReaderComments } from './share-comment-notifications';
import type { ShareInboxComment } from './share-link-api';

const arrived = (id: string, shareId: string, body: string): ShareInboxComment => ({
  id,
  shareId,
  projectId: 'project',
  entityKind: shareId === 'chapter-share' ? 'node' : 'element',
  entityId: shareId === 'chapter-share' ? 'chapter' : 'lin',
  authorName: '合成读者',
  body,
  anchor: { targetBlockId: null, targetBlockIds: [], selectedText: '', blockText: '', blockSelectionFrom: -1, blockSelectionTo: -1, blockSnapshots: [], textAnchor: null },
  status: 'open',
  createdAt: '2026-10-30T00:00:00.000Z',
});

afterEach(() => useNotificationStore.getState().clear());

describe('reader comment notifications', () => {
  it('notifies once per shared entity with the reader and comment, or the count', async () => {
    await i18next.changeLanguage('zh-CN');
    notifyReaderComments([
      arrived('c1', 'chapter-share', '  这里\n节奏太快  '),
      arrived('c2', 'element-share', '一'),
      arrived('c3', 'element-share', '二'),
    ], shareId => (shareId === 'chapter-share' ? '第三章 · 阁楼' : null));
    const items = useNotificationStore.getState().items;
    expect(items.map(item => ({ source: item.source, state: item.state, read: item.read, title: item.title, detail: item.detail, target: item.target }))).toEqual([
      { source: 'share-comment', state: 'completed', read: false, title: '读者评论', detail: '2 条新评论',
        target: { projectId: 'project', entityType: 'element', id: 'lin' } },
      { source: 'share-comment', state: 'completed', read: false, title: '第三章 · 阁楼', detail: '合成读者：这里 节奏太快',
        target: { projectId: 'project', entityType: 'node', id: 'chapter' } },
    ]);
  });

  it('shortens a long comment', () => {
    notifyReaderComments([arrived('long', 'chapter-share', '长'.repeat(120))], () => 'x');
    expect(useNotificationStore.getState().items[0]!.detail).toMatch(/^合成读者：长{80}…$/);
  });
});
