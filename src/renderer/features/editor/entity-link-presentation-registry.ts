import type { EntityLinkColorState, EntityLinkColorMode, EntityLinkKindColors } from '../../lib/entity-link-appearance';
import { buildEntityLinkColorSignature, resolveEntityLinkTargetColor } from '../../lib/entity-link-appearance';
import type { EntityLinkTargetSnapshot } from '../../lib/entity-link-target-state';
import { resolveEntityLinkTargetState } from '../../lib/entity-link-target-state';
import { indexById } from '../../lib/immutable-id-index';
import { entityLinkConfig } from '../../lib/extensions/entity-link';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore } from '../../store/settings-store';

type Data = EntityLinkColorState & EntityLinkTargetSnapshot;
interface Settings { entityLinkInteractive: boolean; entityLinkColorMode: EntityLinkColorMode; entityLinkKindColors: EntityLinkKindColors }
interface Store<T> { getState(): T; subscribe(listener: () => void): () => void }
export interface EntityLinkPresentationChange { targetsChanged: boolean }
const collections = ['bookElements', 'bookNodes', 'storylines', 'bookElementCategories'] as const;
function sameMembership(before: EntityLinkTargetSnapshot, after: EntityLinkTargetSnapshot): boolean {
  for (const key of collections) {
    if (before[key] === after[key]) continue;
    const previous = indexById(before[key]); const current = indexById(after[key]);
    if (previous.size !== current.size) return false;
    for (const id of previous.keys()) if (!current.has(id)) return false;
  }
  if (before.trashedEntityIds === after.trashedEntityIds) return true;
  return before.trashedEntityIds.size === after.trashedEntityIds.size && [...before.trashedEntityIds].every(id => after.trashedEntityIds.has(id));
}

/** One subscription per store while editors are attached; no document ownership. */
export function createEntityLinkPresentationRegistry(data: Store<Data>, settings: Store<Settings>, config: typeof entityLinkConfig) {
  type Owner = { changed(change: EntityLinkPresentationChange): void };
  const owners = new Set<Owner>();
  let previous: EntityLinkTargetSnapshot | null = null;
  let colorSignature: string | null = null;
  let unsubscribe: (() => void)[] = [];
  let reconciling = false; let again = false;
  const reconcile = () => {
    if (reconciling) { again = true; return; }
    reconciling = true;
    try {
      do {
        again = false;
        const state = data.getState(); const preferences = settings.getState();
        const nextColor = buildEntityLinkColorSignature(state, preferences.entityLinkColorMode, preferences.entityLinkKindColors);
        const colorsChanged = colorSignature !== nextColor;
        const targetsChanged = !previous || !sameMembership(previous, state);
        const { bookElements, bookNodes, storylines, bookElementCategories, trashedEntityIds } = state;
        previous = { bookElements, bookNodes, storylines, bookElementCategories, trashedEntityIds };
        colorSignature = nextColor;
        config.interactionEnabled = preferences.entityLinkInteractive;
        if (colorsChanged) config.targetColorVersion++;
        if (colorsChanged || targetsChanged) for (const owner of [...owners]) {
          if (owners.has(owner)) owner.changed({ targetsChanged });
        }
      } while (again && owners.size > 0);
    } finally { reconciling = false; }
  };
  return {
    attach(changed: Owner['changed']) {
      if (owners.size === 0) {
        // Resolvers read current stores at use time; they retain no workspace
        // snapshot and cannot be overwritten by a later editor's old effect.
        config.resolveTargetState = (kind, id) => resolveEntityLinkTargetState(data.getState(), kind, id);
        config.resolveTargetColor = (kind, id) => {
          const preferences = settings.getState();
          return resolveEntityLinkTargetColor(kind, id, data.getState(), preferences.entityLinkColorMode, preferences.entityLinkKindColors);
        };
        unsubscribe = [data.subscribe(reconcile), settings.subscribe(reconcile)];
        reconcile();
      }
      const owner = { changed }; owners.add(owner); changed({ targetsChanged: true });
      return () => {
        if (!owners.delete(owner)) return;
        if (owners.size === 0) {
          for (const off of unsubscribe) off(); unsubscribe = [];
          previous = null; colorSignature = null;
        }
      };
    },
  };
}

export const entityLinkPresentationRegistry = createEntityLinkPresentationRegistry(useDataStore, useSettingsStore, entityLinkConfig);
