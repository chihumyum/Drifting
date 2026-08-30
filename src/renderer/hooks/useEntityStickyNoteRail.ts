import { useCallback, useSyncExternalStore } from 'react';

import type { CommentTargetKind } from '../domain/comment';
import { events } from '../lib/events';

export type StickyNoteRailLayout = 'stacked' | 'expanded';

export interface StickyNoteRailState {
  visible: boolean;
  layout: StickyNoteRailLayout;
  itemIds: readonly string[];
}

interface StickyNoteRailChange {
  kind: CommentTargetKind;
  id: string;
}

const EMPTY_RAIL: StickyNoteRailState = {
  visible: false,
  layout: 'expanded',
  itemIds: [],
};

// Sticky-note membership is working-session UI, not authored project state.
// The registry recovers each editor's rail while papers switch without adding
// browser-persisted or project-sync state.
const stickyNoteRailListeners = new Set<(change: StickyNoteRailChange) => void>();
const stickyNoteRailValues = new Map<string, StickyNoteRailState>();
let registryRevision = 0;

function storageKey(kind: CommentTargetKind, id: string): string {
  return `${kind}:${id}`;
}

function defaultLayout(): StickyNoteRailLayout {
  if (typeof window === 'undefined') return 'expanded';
  return window.matchMedia?.('(max-width: 767px)').matches ? 'stacked' : 'expanded';
}

export function stickyNoteRailSnapshot(
  kind: CommentTargetKind,
  id: string | null | undefined,
): StickyNoteRailState {
  if (!id) return EMPTY_RAIL;
  const key = storageKey(kind, id);
  const existing = stickyNoteRailValues.get(key);
  if (existing) return existing;
  const initial = {
    ...EMPTY_RAIL,
    layout: defaultLayout(),
  };
  stickyNoteRailValues.set(key, initial);
  return initial;
}

function writeState(
  kind: CommentTargetKind,
  id: string,
  update: (current: StickyNoteRailState) => StickyNoteRailState,
): void {
  const key = storageKey(kind, id);
  const current = stickyNoteRailSnapshot(kind, id);
  const next = update(current);
  if (
    current.visible === next.visible &&
    current.layout === next.layout &&
    current.itemIds.length === next.itemIds.length &&
    current.itemIds.every((itemId, index) => itemId === next.itemIds[index])
  ) {
    return;
  }
  stickyNoteRailValues.set(key, next);
  registryRevision += 1;
  stickyNoteRailListeners.forEach((listener) => listener({ kind, id }));
}

export function addCommentToStickyNoteRail(
  kind: CommentTargetKind,
  entityId: string,
  commentId: string,
): void {
  const destinationKey = storageKey(kind, entityId);
  for (const [key, state] of stickyNoteRailValues) {
    if (key === destinationKey || !state.itemIds.includes(commentId)) continue;
    const separator = key.indexOf(':');
    if (separator < 0) continue;
    writeState(
      key.slice(0, separator) as CommentTargetKind,
      key.slice(separator + 1),
      (current) => ({
        ...current,
        itemIds: current.itemIds.filter((id) => id !== commentId),
      }),
    );
  }
  writeState(kind, entityId, (current) => ({
    ...current,
    visible: true,
    itemIds: [commentId, ...current.itemIds.filter((id) => id !== commentId)],
  }));
}

export function removeCommentFromStickyNoteRail(
  kind: CommentTargetKind,
  entityId: string,
  commentId: string,
): void {
  writeState(kind, entityId, (current) => ({
    ...current,
    itemIds: current.itemIds.filter((id) => id !== commentId),
  }));
}

export function removeCommentFromAllStickyNoteRails(commentId: string): void {
  for (const [key, current] of stickyNoteRailValues) {
    if (!current.itemIds.includes(commentId)) continue;
    const separator = key.indexOf(':');
    if (separator < 0) continue;
    const kind = key.slice(0, separator) as CommentTargetKind;
    const id = key.slice(separator + 1);
    writeState(kind, id, (value) => ({
      ...value,
      itemIds: value.itemIds.filter((itemId) => itemId !== commentId),
    }));
  }
}

export function commentStickyNoteRailTarget(commentId: string): {
  kind: CommentTargetKind;
  id: string;
} | null {
  for (const [key, state] of stickyNoteRailValues) {
    if (!state.itemIds.includes(commentId)) continue;
    const separator = key.indexOf(':');
    if (separator < 0) continue;
    return {
      kind: key.slice(0, separator) as CommentTargetKind,
      id: key.slice(separator + 1),
    };
  }
  return null;
}

export function useStickyNoteRailRegistryRevision(): number {
  return useSyncExternalStore(
    (notify) => {
      const listener = () => notify();
      stickyNoteRailListeners.add(listener);
      return () => stickyNoteRailListeners.delete(listener);
    },
    () => registryRevision,
    () => 0,
  );
}

export function useEntityStickyNoteRail(
  kind: CommentTargetKind,
  entityId: string | null | undefined,
) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!entityId) return () => undefined;
      const listener = (change: StickyNoteRailChange) => {
        if (change.kind === kind && change.id === entityId) notify();
      };
      stickyNoteRailListeners.add(listener);
      return () => stickyNoteRailListeners.delete(listener);
    },
    [entityId, kind],
  );
  const getSnapshot = useCallback(
    () => stickyNoteRailSnapshot(kind, entityId),
    [entityId, kind],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_RAIL);

  const setVisible = useCallback(
    (visible: boolean) => {
      if (!entityId) return;
      writeState(kind, entityId, (current) => ({ ...current, visible }));
    },
    [entityId, kind],
  );
  const setLayout = useCallback(
    (layout: StickyNoteRailLayout) => {
      if (!entityId) return;
      writeState(kind, entityId, (current) => ({ ...current, layout }));
    },
    [entityId, kind],
  );
  const add = useCallback(
    (commentId: string) => {
      if (!entityId) return;
      addCommentToStickyNoteRail(kind, entityId, commentId);
    },
    [entityId, kind],
  );
  const remove = useCallback(
    (commentId: string) => {
      if (!entityId) return;
      removeCommentFromStickyNoteRail(kind, entityId, commentId);
    },
    [entityId, kind],
  );
  const clear = useCallback(() => {
    if (!entityId) return;
    writeState(kind, entityId, (current) => ({ ...current, itemIds: [] }));
  }, [entityId, kind]);

  return { ...state, setVisible, setLayout, add, remove, clear };
}

events.on('comment:deleted', ({ commentId }) => {
  removeCommentFromAllStickyNoteRails(commentId);
});
