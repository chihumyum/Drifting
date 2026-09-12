import type { EntityKind } from '../domain/entity-kinds';
import type { useDataStore } from '../store/data-store';

export const ENTITY_LINK_COLOR_MODES = ['contextual', 'kind', 'hover', 'prose'] as const;
export type EntityLinkColorMode = (typeof ENTITY_LINK_COLOR_MODES)[number];

export const ENTITY_LINK_COLOR_KINDS = [
  'element',
  'chapter',
  'drift',
  'patch',
  'category',
  'storyline',
] as const;
export type EntityLinkColorKind = (typeof ENTITY_LINK_COLOR_KINDS)[number];
export type EntityLinkKindColors = Record<EntityLinkColorKind, string>;

export const DEFAULT_ENTITY_LINK_KIND_COLORS: EntityLinkKindColors = {
  element: '#8b72c6',
  chapter: '#5b93c7',
  drift: '#9b6baa',
  patch: '#c28b43',
  category: '#5f9b73',
  storyline: '#4f9497',
};

type DataStoreSnapshot = ReturnType<typeof useDataStore.getState>;
export type EntityLinkColorState = Pick<
  DataStoreSnapshot,
  | 'bookElements'
  | 'bookElementCategories'
  | 'bookNodes'
  | 'storylines'
  | 'primaryStorylineByNode'
  | 'driftGroups'
>;

export function normalizeEntityLinkColorMode(value: unknown): EntityLinkColorMode {
  return ENTITY_LINK_COLOR_MODES.includes(value as EntityLinkColorMode)
    ? (value as EntityLinkColorMode)
    : 'contextual';
}

export function normalizeEntityLinkHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

export function normalizeEntityLinkKindColors(value: unknown): EntityLinkKindColors {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    ENTITY_LINK_COLOR_KINDS.map((kind) => [
      kind,
      normalizeEntityLinkHexColor(input[kind], DEFAULT_ENTITY_LINK_KIND_COLORS[kind]),
    ]),
  ) as EntityLinkKindColors;
}

// Store collections are immutable snapshots. Share each collection's index
// across resolvers/editors without retaining retired project arrays. Keeping
// first-match behavior also matches the previous Array.find contract.
const collectionIndexes = new WeakMap<readonly { id: string }[], ReadonlyMap<string, { id: string }>>();

function findById<T extends { id: string }>(records: readonly T[], id: string): T | undefined {
  let index = collectionIndexes.get(records);
  if (!index) {
    const next = new Map<string, T>();
    for (const record of records) if (!next.has(record.id)) next.set(record.id, record);
    index = next;
    collectionIndexes.set(records, index);
  }
  return index.get(id) as T | undefined;
}

function contextualColor(
  kind: EntityKind,
  id: string,
  state: EntityLinkColorState,
): string | null {
  if (kind === 'element') {
    const element = findById(state.bookElements, id);
    if (!element?.categoryId) return null;
    return (
      findById(state.bookElementCategories, element.categoryId)?.color ??
      null
    );
  }

  if (kind === 'node') {
    const node = findById(state.bookNodes, id);
    if (!node) return null;
    if (node.kind === 'drift') {
      if (!node.driftGroupId) return null;
      return findById(state.driftGroups, node.driftGroupId)?.color ?? null;
    }
    const storylineId = state.primaryStorylineByNode[node.id] ?? null;
    return storylineId
      ? findById(state.storylines, storylineId)?.color ?? null
      : null;
  }

  if (kind === 'category') {
    return findById(state.bookElementCategories, id)?.color ?? null;
  }

  if (kind === 'storyline') {
    return findById(state.storylines, id)?.color ?? null;
  }

  // Element patches are not hydrated in useDataStore, so contextual mode
  // keeps the existing CSS fallback instead of opening a query while painting.
  return null;
}

function kindColor(
  kind: EntityKind,
  id: string,
  state: EntityLinkColorState,
  colors: EntityLinkKindColors,
): string | null {
  if (kind === 'node') {
    return findById(state.bookNodes, id)?.kind === 'drift'
      ? colors.drift
      : colors.chapter;
  }
  if (kind === 'element') return colors.element;
  if (kind === 'patch') return colors.patch;
  if (kind === 'category') return colors.category;
  if (kind === 'storyline') return colors.storyline;
  return null;
}

export function resolveEntityLinkTargetColor(
  kind: EntityKind,
  id: string,
  state: EntityLinkColorState,
  mode: EntityLinkColorMode,
  colors: EntityLinkKindColors,
): string | null {
  if (mode === 'prose') return null;
  if (mode === 'kind') return kindColor(kind, id, state, colors);
  return contextualColor(kind, id, state);
}

/**
 * A presentation-only signature that changes only when link colors can change.
 * It avoids repainting every open editor after ordinary content/summary writes.
 */
function computeEntityLinkColorSignature(
  state: EntityLinkColorState,
  mode: EntityLinkColorMode,
  colors: EntityLinkKindColors,
): string {
  if (mode === 'prose') return mode;
  if (mode === 'kind') {
    return JSON.stringify([mode, colors, state.bookNodes.map((node) => [node.id, node.kind])]);
  }
  return [
    mode,
    state.bookElementCategories.map((category) => `${category.id}=${category.color}`).join(','),
    state.bookElements.map((element) => `${element.id}=${element.categoryId ?? ''}`).join(','),
    state.storylines.map((storyline) => `${storyline.id}=${storyline.color}`).join(','),
    state.driftGroups.map((group) => `${group.id}=${group.color ?? ''}`).join(','),
    state.bookNodes
      .map(
        (node) =>
          `${node.id}=${node.kind}:${
            node.kind === 'chapter'
              ? state.primaryStorylineByNode[node.id] ?? ''
              : node.driftGroupId ?? ''
          }`,
      )
      .join(','),
  ].join('\n');
}

interface ColorSignatureCache {
  input: EntityLinkColorState;
  mode: EntityLinkColorMode;
  colors: EntityLinkKindColors;
  signature: string;
}
const colorSignatures = new WeakMap<EntityLinkColorState['bookNodes'], ColorSignatureCache>();

/** Compute once per collection snapshot, shared by every retained editor. */
export function buildEntityLinkColorSignature(
  state: EntityLinkColorState,
  mode: EntityLinkColorMode,
  colors: EntityLinkKindColors,
): string {
  if (mode === 'prose') return mode;
  const cached = colorSignatures.get(state.bookNodes);
  if (cached?.mode === mode && cached.colors === colors
    && cached.input.bookElements === state.bookElements
    && cached.input.bookElementCategories === state.bookElementCategories
    && cached.input.storylines === state.storylines
    && cached.input.primaryStorylineByNode === state.primaryStorylineByNode
    && cached.input.driftGroups === state.driftGroups) return cached.signature;
  const signature = computeEntityLinkColorSignature(state, mode, colors);
  // Copy only collection references; never retain the entire Zustand state.
  const { bookNodes, bookElements, bookElementCategories, storylines, primaryStorylineByNode, driftGroups } = state;
  colorSignatures.set(bookNodes, {
    input: { bookNodes, bookElements, bookElementCategories, storylines, primaryStorylineByNode, driftGroups },
    mode, colors, signature,
  });
  return signature;
}
