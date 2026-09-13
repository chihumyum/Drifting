import type { EntityKind } from '../domain/entity-kinds';
import { trashedKey } from '../store/data-store';
import type { EntityLinkTargetState } from './extensions/entity-link';
import { indexById } from './immutable-id-index';

type IdCollection = readonly { readonly id: string }[];
export interface EntityLinkTargetSnapshot {
  readonly bookElements: IdCollection;
  readonly bookNodes: IdCollection;
  readonly storylines: IdCollection;
  readonly bookElementCategories: IdCollection;
  readonly trashedEntityIds: ReadonlySet<string>;
}

/** Read the supplied current snapshot; share indexes with other ID consumers. */
export function resolveEntityLinkTargetState(
  state: EntityLinkTargetSnapshot,
  kind: EntityKind,
  id: string,
): EntityLinkTargetState {
  let records: IdCollection;
  switch (kind) {
    case 'element': records = state.bookElements; break;
    case 'node': records = state.bookNodes; break;
    case 'storyline': records = state.storylines; break;
    case 'category': records = state.bookElementCategories; break;
    // Preserve navigation for kinds whose existence is owned elsewhere.
    default: return 'alive';
  }
  if (indexById(records).has(id)) return 'alive';
  return state.trashedEntityIds.has(trashedKey(kind, id)) ? 'trashed' : 'gone';
}
