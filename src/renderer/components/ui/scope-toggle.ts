/** What "the current thing" is called on a scope toggle. */
export type ScopeToggleSubject =
  | 'chapter'
  | 'drift'
  | 'element'
  | 'storyline'
  | 'category'
  | 'material'
  | 'current';

/** The toggle's subject for a focused entity kind (a drift node is an idea). */
export function scopeToggleSubject(kind: string | null | undefined, isDrift = false): ScopeToggleSubject {
  switch (kind) {
    case 'node':
      return isDrift ? 'drift' : 'chapter';
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'category':
      return 'category';
    case 'library_item':
      return 'material';
    default:
      return 'current';
  }
}
