import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { kindMarkOfTarget, type KindMarkKind } from '../../../components/ui/kind-mark';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { indexById } from '../../../lib/immutable-id-index';

export interface MobilePaperMark {
  kind: KindMarkKind;
  /** The storyline's or category's colour; undefined draws muted ink. */
  color?: string;
  seed: string;
  title: string;
}

/** Each open paper's sand mark and name, as the dock and the cards show them. */
export function useMobilePaperMarks(targets: readonly WorkspaceTarget[]): MobilePaperMark[] {
  const { t } = useTranslation();
  const { bookNodes, storylines, bookElements, bookElementCategories, libraryItems, primaryStorylineByNode } =
    useDataStoreFields('bookNodes', 'storylines', 'bookElements', 'bookElementCategories', 'libraryItems', 'primaryStorylineByNode');
  return useMemo(() => {
    const nodes = indexById(bookNodes);
    const lines = indexById(storylines);
    const elements = indexById(bookElements);
    const categories = indexById(bookElementCategories);
    const materials = indexById(libraryItems);
    return targets.map((target): MobilePaperMark => {
      switch (target.entityType) {
        case 'node': {
          const node = nodes.get(target.id);
          const drift = node?.kind === 'drift';
          const primary = node ? primaryStorylineByNode[node.id] : undefined;
          return {
            kind: kindMarkOfTarget('node', drift),
            color: primary ? lines.get(primary)?.color : undefined,
            seed: target.id,
            title: node?.title || t(drift ? 'topTimeline.untitled.drift' : 'topTimeline.untitled.chapter'),
          };
        }
        case 'storyline': {
          const line = lines.get(target.id);
          return { kind: 'storyline', color: line?.color, seed: target.id, title: line?.name || t('topTimeline.untitled.storyline') };
        }
        case 'element': {
          const element = elements.get(target.id);
          const category = element?.categoryId ? categories.get(element.categoryId) : undefined;
          return { kind: 'element', color: category?.color, seed: target.id, title: element?.name || t('topTimeline.untitled.element') };
        }
        case 'category': {
          const category = categories.get(target.id);
          return { kind: 'category', color: category?.color, seed: target.id, title: category?.name || t('leftSidebar.uncategorized') };
        }
        case 'library_item': {
          const item = materials.get(target.id);
          return { kind: 'material', seed: target.id, title: item?.title || t('topTimeline.untitled.library_item') };
        }
        case 'all-chapters':
          return { kind: 'all', seed: 'all', title: t('rightSidebar.targets.allChapters') };
      }
    });
  }, [bookElementCategories, bookElements, bookNodes, libraryItems, primaryStorylineByNode, storylines, t, targets]);
}
