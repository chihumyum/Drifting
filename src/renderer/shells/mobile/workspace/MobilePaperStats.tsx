import { isDrift } from '../../../domain/book-node';
import { EntityStatsContent } from '../../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../../features/stats/entity-stats-types';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { useMobilePaperPresentation } from './MobilePaperContent';

function statsTarget(
  target: WorkspaceTarget,
  presentation: ReturnType<typeof useMobilePaperPresentation>,
  data: ReturnType<typeof useDataStore.getState>,
): EntityStatsTarget {
  if (target.entityType === 'all-chapters') {
    return {
      kind: 'all-chapters',
      id: null,
      title: presentation.title,
      kicker: presentation.kicker,
    };
  }
  if (target.entityType === 'node') {
    const node = data.bookNodes.find((item) => item.id === target.id);
    return {
      kind: node && isDrift(node) ? 'drift' : 'chapter',
      id: target.id,
      title: presentation.title,
      kicker: presentation.kicker,
      color: presentation.color,
    };
  }
  return {
    kind: target.entityType,
    id: target.id,
    title: presentation.title,
    kicker: presentation.kicker,
    color: presentation.color,
  };
}

export function MobilePaperStats({ target }: { target: WorkspaceTarget }) {
  const data = useDataStore();
  const presentation = useMobilePaperPresentation(target);
  return <div className="m-paper-stats"><EntityStatsContent target={statsTarget(target, presentation, data)} bookNodes={data.bookNodes} bookActs={data.bookActs} bookElements={data.bookElements} storylines={data.storylines} categories={data.bookElementCategories} storylineNodeMapping={data.storylineNodeMapping} primaryStorylineByNode={data.primaryStorylineByNode} /></div>;
}
