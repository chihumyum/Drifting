import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import type { StructuralEntityKind } from '../../domain/entity-kinds';
import { isChapter } from '../../domain/book-node';
import { parseKv } from '../../domain/kv';
import { resolvePrimaryStorylineId } from '../../domain/node-storyline-state';
import { useDataStore } from '../../store/data-store';

export const HOVER_PREVIEW_DELAY_MS = 220;

export interface EntityHoverTarget {
  kind: StructuralEntityKind;
  id: string;
}

export interface EntityHoverPreview<T> {
  data: T;
  anchor: HTMLElement;
}

export interface EntityHoverMetaItem {
  text: string;
  color?: string | null;
  tone?: 'secondary';
}

export interface EntityHoverCardContent {
  summary: string | null | undefined;
  meta: EntityHoverMetaItem[];
}

type DataStoreSnapshot = ReturnType<typeof useDataStore.getState>;

const STATUS_KEYS = {
  draft: 'editorTopBar.status.draft',
  finished: 'editorTopBar.status.finished',
  discarded: 'editorTopBar.status.discarded',
  drifting: 'editorTopBar.status.drifting',
  resting: 'editorTopBar.status.resting',
} as const;

function compactAliases(aliases: string[]): string | null {
  if (aliases.length === 0) return null;
  const visible = aliases.slice(0, 3).join(' · ');
  const remaining = aliases.length - 3;
  return `AKA ${visible}${remaining > 0 ? ` +${remaining}` : ''}`;
}

function kvMeta(raw: string): EntityHoverMetaItem[] {
  return parseKv(raw).flatMap(({ key, value }) => {
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    if (!cleanKey && !cleanValue) return [];
    return [{ text: cleanKey && cleanValue ? `${cleanKey}：${cleanValue}` : cleanKey || cleanValue }];
  });
}

/** Build summary + cheap metadata exclusively from the already-hydrated store. */
export function buildEntityHoverCardContent(
  target: EntityHoverTarget,
  state: DataStoreSnapshot,
  t: TFunction,
): EntityHoverCardContent | null {
  if (target.kind === 'node') {
    const node = state.bookNodes.find((candidate) => candidate.id === target.id);
    if (!node) return null;
    const meta: EntityHoverMetaItem[] = [
      { text: t(STATUS_KEYS[node.writingStatus]) },
      { text: t('nodeEditor.meta.words', { count: node.wordCount.toLocaleString() }) },
    ];
    if (isChapter(node)) {
      const storylineById = new Map(state.storylines.map((candidate) => [candidate.id, candidate]));
      const storylineIds = (state.nodeStorylineMapping[node.id] ?? []).filter((id) =>
        storylineById.has(id),
      );
      const storylineId = resolvePrimaryStorylineId(
        state.primaryStorylineByNode[node.id],
        storylineIds,
      );
      const storyline = storylineId ? storylineById.get(storylineId) : null;
      meta.push({
        text: storyline?.name ?? t('nodeEditor.empty.noStoryline'),
        color: storyline?.color,
      });
      for (const secondaryStorylineId of storylineIds) {
        if (secondaryStorylineId === storylineId) continue;
        const secondaryStoryline = storylineById.get(secondaryStorylineId);
        if (!secondaryStoryline) continue;
        meta.push({
          text: secondaryStoryline.name,
          color: secondaryStoryline.color,
          tone: 'secondary',
        });
      }
    } else if (node.driftGroupId) {
      const groupsById = new Map(state.driftGroups.map((group) => [group.id, group]));
      const groupPath: string[] = [];
      const seen = new Set<string>();
      let group = groupsById.get(node.driftGroupId) ?? null;
      const color = group?.color;
      while (group && !seen.has(group.id)) {
        seen.add(group.id);
        groupPath.unshift(group.name);
        group = group.parentGroupId ? groupsById.get(group.parentGroupId) ?? null : null;
      }
      if (groupPath.length > 0) meta.push({ text: groupPath.join(' / '), color });
    }
    return { summary: node.summary, meta };
  }

  if (target.kind === 'element') {
    const element = state.bookElements.find((candidate) => candidate.id === target.id);
    if (!element) return null;
    const category = element.categoryId
      ? state.bookElementCategories.find((candidate) => candidate.id === element.categoryId)
      : null;
    const meta: EntityHoverMetaItem[] = [
      {
        text: category?.name ?? t('leftSidebar.uncategorized'),
        color: category?.color,
      },
    ];
    if (element.groupName) meta.push({ text: element.groupName });
    const aliases = compactAliases(element.aliases);
    if (aliases) meta.push({ text: aliases });
    meta.push(...kvMeta(element.kvJson));
    return { summary: element.summary, meta };
  }

  if (target.kind === 'storyline') {
    const storyline = state.storylines.find((candidate) => candidate.id === target.id);
    if (!storyline) return null;
    const nodeIds = state.storylineNodeMapping[storyline.id] ?? [];
    const nodeIdSet = new Set(nodeIds);
    const nodes = state.bookNodes.filter((node) => nodeIdSet.has(node.id));
    const words = nodes.reduce((sum, node) => sum + node.wordCount, 0);
    return {
      summary: storyline.summary,
      meta: [
        { text: t('storylineEditor.meta.chapters', { count: nodes.length }) },
        { text: t('storylineEditor.meta.kWords', { count: (words / 1000).toFixed(1) }) },
        ...kvMeta(storyline.kvJson),
      ],
    };
  }

  if (target.kind === 'category') {
    const category = state.bookElementCategories.find((candidate) => candidate.id === target.id);
    if (!category) return null;
    const count = state.bookElements.filter((element) => element.categoryId === category.id).length;
    return {
      summary: null,
      meta: [{ text: t('categoryEditor.meta.elements', { count }), color: category.color }],
    };
  }

  // Element patches are not mirrored in useDataStore. Hover must stay cheap,
  // so it deliberately does not open a repository query just for a preview.
  return null;
}

/**
 * Shared hover-intent state for sidebar rows and inline entity links. The
 * anchor element is retained so a visible card can reposition on scroll.
 */
export function useHoverPreview<T>(delayMs = HOVER_PREVIEW_DELAY_MS) {
  const [preview, setPreview] = useState<EntityHoverPreview<T> | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const onEnter = useCallback(
    (data: T, anchor: HTMLElement) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (anchor.isConnected) setPreview({ data, anchor });
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const onLeave = useCallback(() => {
    clearTimer();
    setPreview(null);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);
  return { preview, onEnter, onLeave };
}
