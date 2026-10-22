import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { isChapter } from '../../domain/book-node';
import { chapterOrderAfter } from '../../domain/chapter-insert';
import { useDataStore } from '../../store/data-store';
import { useBookNode } from '../../usecase/useBookNode';
import { requestChapterTitleFocus } from './chapter-title-focus';

const log = loglevel.getLogger('useChapterInsert');
log.setLevel(loglevel.levels.WARN);

/**
 * Creates a chapter directly after `afterNodeId` in reading order (null =
 * after the last chapter) and asks its editor to focus the title. Like the
 * sidebar's 新章节 the insert carries position only, so the chapter lands
 * 未归属. Resolves to the new id, or null while another insert is in flight
 * or when the write fails.
 */
export function useChapterInsert({ projectId, userId }: { projectId: string; userId: string }) {
  const { t } = useTranslation();
  const { createNode } = useBookNode({ projectId, userId });
  const pendingRef = useRef(false);

  return useCallback(
    async (afterNodeId: string | null): Promise<string | null> => {
      if (pendingRef.current) return null;
      pendingRef.current = true;
      try {
        const { bookNodes, bookActs } = useDataStore.getState();
        const chapters = bookNodes.filter(isChapter);
        const after = afterNodeId ? chapters.find((node) => node.id === afterNodeId) : undefined;
        const created = await createNode({
          kind: 'chapter',
          title: t('chapterEnd.defaultTitle'),
          bookOrder: chapterOrderAfter(
            chapters.map((node) => node.bookOrder),
            bookActs,
            after?.bookOrder ?? null,
          ),
          mainStorylineId: null,
        });
        requestChapterTitleFocus(created.id);
        return created.id;
      } catch (error) {
        log.error('Failed to insert chapter', afterNodeId, error);
        return null;
      } finally {
        pendingRef.current = false;
      }
    },
    [createNode, t],
  );
}
