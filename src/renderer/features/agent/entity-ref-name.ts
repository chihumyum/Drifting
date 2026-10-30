/** Names and marks for the entities an Agent turn touched. */
import type { KindMarkKind } from '../../components/ui/kind-mark';
import type { ActivityEntityType, ToolEntityRef } from '../../lib/agent/tool-entity-ref';
import type { useDataStore } from '../../store/data-store';

export const ENTITY_MARK: Record<ActivityEntityType, KindMarkKind> = {
  node: 'chapter',
  element: 'element',
  storyline: 'storyline',
  category: 'category',
};

export function entityRefName(
  s: ReturnType<typeof useDataStore.getState>,
  ref: Pick<ToolEntityRef, 'entityType' | 'id'>,
  deletedLabel: string,
): string {
  switch (ref.entityType) {
    case 'node':
      return s.bookNodes.find((n) => n.id === ref.id)?.title || deletedLabel;
    case 'element':
      return s.bookElements.find((e) => e.id === ref.id)?.name || deletedLabel;
    case 'storyline':
      return s.storylines.find((sl) => sl.id === ref.id)?.name || deletedLabel;
    case 'category':
      return s.bookElementCategories.find((c) => c.id === ref.id)?.name || deletedLabel;
    default:
      return ref.id;
  }
}
