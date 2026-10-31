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

const SHAPE: Record<Exclude<KindMarkKind, 'chapter'>, string> = {
  element: 'square',
  storyline: 'dash',
  category: 'corner',
  drift: 'spiral',
  'drift-group': 'wave',
  material: 'slip',
  all: 'star',
};

/** Chapters press one of six seals, always the same one for the same chapter. */
function sealOf(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  return `blob-${Math.abs(hash) % 6}`;
}

/** The sand shape a kind mark draws, for code that builds the mark without React. */
export function kindMarkShape(kind: KindMarkKind, seed = '') {
  return kind === 'chapter' ? sealOf(seed) : SHAPE[kind];
}
