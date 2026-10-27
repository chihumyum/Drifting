import type { WorkspaceEntityType } from '../../features/workspace/navigation/workspace-target';

/** The kinds of things that carry a sand mark (see `KindMark`). */
export type KindMarkKind =
  | 'chapter'
  | 'element'
  | 'storyline'
  | 'category'
  | 'drift'
  | 'drift-group'
  | 'material'
  | 'all';

/** The mark of a workspace target (a tab, a list cell). */
export function kindMarkOfTarget(entityType: WorkspaceEntityType, isDrift = false): KindMarkKind {
  switch (entityType) {
    case 'node': return isDrift ? 'drift' : 'chapter';
    case 'element': return 'element';
    case 'storyline': return 'storyline';
    case 'category': return 'category';
    case 'library_item': return 'material';
    default: return 'all';
  }
}
