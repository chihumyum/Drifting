import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import type { StructuralEntityKind } from '../../../domain/entity-kinds';
import { canonicalWordCount, isChapter } from '../../../domain/book-node';
import { parseKv } from '../../../domain/kv';
import { resolvePrimaryStorylineId } from '../../../domain/node-storyline-state';
import { useDataStore } from '../../../store/data-store';
import { HOVER_CARD_GRACE_MS, HOVER_PREVIEW_DELAY_MS, SCROLL_REST_MS } from '../../../lib/motion';
import type { KindMarkKind } from '../../../components/ui/kind-mark';

export { HOVER_PREVIEW_DELAY_MS };

export interface EntityHoverTarget {
  kind: StructuralEntityKind;
  id: string;
}

export interface EntityHoverPreview<T> {
  data: T;
  anchor: HTMLElement;
}

/** A kind mark: the thing's own in the head, what it belongs to in a tag. */
export interface EntityHoverMark {
  kind: KindMarkKind;
  color?: string | null;
  seed?: string;
  loose?: boolean;
}

/** One thing it belongs to or is known by, in the line under the title. */
export interface EntityHoverTag {
  text: string;
  mark?: EntityHoverMark;
  tone?: 'secondary';
}

export interface EntityHoverCardContent {
  title: string;
  mark: EntityHoverMark;
  /** A count on the right of the title: words, chapters, elements. */
  index?: string;
  /** The writing status, named in the line under the title when the card has no choice of it. */
  status?: string;
  tags: EntityHoverTag[];
  kv: Array<{ key: string; value: string }>;
  summary: string | null | undefined;
}

type DataStoreSnapshot = Pick<ReturnType<typeof useDataStore.getState>,
  'bookNodes' | 'bookElements' | 'bookElementCategories' | 'storylines' |
  'nodeStorylineMapping' | 'primaryStorylineByNode' | 'storylineNodeMapping' | 'driftGroups'
>;

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

function kvRows(raw: string): Array<{ key: string; value: string }> {
  return parseKv(raw).flatMap(({ key, value }) => {
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    if (!cleanKey && !cleanValue) return [];
    return [{ key: cleanKey, value: cleanValue }];
  });
}

/** Build the card's head, tags and summary from the already-hydrated store only. */
export function buildEntityHoverCardContent(
  target: EntityHoverTarget,
  state: DataStoreSnapshot,
  t: TFunction,
): EntityHoverCardContent | null {
  if (target.kind === 'node') {
    const node = state.bookNodes.find((candidate) => candidate.id === target.id);
    if (!node) return null;
    const words = canonicalWordCount(node);
    const index = words == null
      ? t('common.counting')
      : t('nodeEditor.meta.words', { count: words.toLocaleString() });
    const content = {
      title: node.title || t('common.untitled'),
      index,
      status: t(STATUS_KEYS[node.writingStatus]),
      kv: [],
      summary: node.summary,
    };
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
      const tags: EntityHoverTag[] = [
        storyline
          ? { text: storyline.name, mark: { kind: 'storyline', color: storyline.color } }
          : { text: t('nodeEditor.empty.noStoryline') },
      ];
      for (const secondaryStorylineId of storylineIds) {
        if (secondaryStorylineId === storylineId) continue;
        const secondaryStoryline = storylineById.get(secondaryStorylineId);
        if (!secondaryStoryline) continue;
        tags.push({
          text: secondaryStoryline.name,
          mark: { kind: 'storyline', color: secondaryStoryline.color },
          tone: 'secondary',
        });
      }
      return { ...content, mark: { kind: 'chapter', seed: node.id, color: storyline?.color }, tags };
    }
    const groupsById = new Map(state.driftGroups.map((group) => [group.id, group]));
    const groupPath: string[] = [];
    const seen = new Set<string>();
    let group = node.driftGroupId ? (groupsById.get(node.driftGroupId) ?? null) : null;
    const color = group?.color;
    while (group && !seen.has(group.id)) {
      seen.add(group.id);
      groupPath.unshift(group.name);
      group = group.parentGroupId ? (groupsById.get(group.parentGroupId) ?? null) : null;
    }
    return {
      ...content,
      mark: { kind: 'drift', color, loose: groupPath.length === 0 },
      tags: groupPath.length > 0 ? [{ text: groupPath.join(' / '), mark: { kind: 'drift-group', color } }] : [],
    };
  }

  if (target.kind === 'element') {
    const element = state.bookElements.find((candidate) => candidate.id === target.id);
    if (!element) return null;
    const category = element.categoryId
      ? state.bookElementCategories.find((candidate) => candidate.id === element.categoryId)
      : null;
    const tags: EntityHoverTag[] = [
      category
        ? { text: category.name, mark: { kind: 'category', color: category.color } }
        : { text: t('leftSidebar.uncategorized') },
    ];
    if (element.groupName) tags.push({ text: element.groupName });
    const aliases = compactAliases(element.aliases);
    if (aliases) tags.push({ text: aliases, tone: 'secondary' });
    return {
      title: element.name,
      mark: { kind: 'element', color: category?.color },
      tags,
      kv: kvRows(element.kvJson),
      summary: element.summary,
    };
  }

  if (target.kind === 'storyline') {
    const storyline = state.storylines.find((candidate) => candidate.id === target.id);
    if (!storyline) return null;
    const nodeIds = state.storylineNodeMapping[storyline.id] ?? [];
    const nodeIdSet = new Set(nodeIds);
    const nodes = state.bookNodes.filter((node) => nodeIdSet.has(node.id));
    const wordCounts = nodes.filter(isChapter).map(canonicalWordCount);
    const words = wordCounts.every((value) => value != null)
      ? wordCounts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
    return {
      title: storyline.name || t('common.untitled'),
      mark: { kind: 'storyline', color: storyline.color },
      index: [
        t('storylineEditor.meta.chapters', { count: nodes.length }),
        words == null
          ? t('common.counting')
          : t('storylineEditor.meta.kWords', { count: (words / 1000).toFixed(1) }),
      ].join(' · '),
      tags: [],
      kv: kvRows(storyline.kvJson),
      summary: storyline.summary,
    };
  }

  if (target.kind === 'category') {
    const category = state.bookElementCategories.find((candidate) => candidate.id === target.id);
    if (!category) return null;
    const count = state.bookElements.filter((element) => element.categoryId === category.id).length;
    return {
      title: category.name,
      mark: { kind: 'category', color: category.color },
      index: t('categoryEditor.meta.elements', { count }),
      tags: [],
      kv: [],
      summary: null,
    };
  }

  // Element patches are not mirrored in useDataStore. Hover must stay cheap,
  // so it deliberately does not open a repository query just for a preview.
  return null;
}

// Leaving a row gives the pointer HOVER_CARD_GRACE_MS to reach its card's actions.

/**
 * Shared hover-intent state for sidebar rows, timeline clips, cards and
 * inline entity links. The anchor element is retained so a visible card can
 * reposition on scroll. `onLeave` waits a moment before closing so the
 * pointer can cross into the card (`card` goes on the card); `dismiss`
 * closes at once, for clicks and drags; `open` shows at once.
 */
// Rows that slide under a resting pointer while a list scrolls are not being
// pointed at: a card waits for the pointer itself to move onto a row
// (SCROLL_REST_MS after the scroll stops).
let lastScrollAt = Number.NEGATIVE_INFINITY;
let watchingScroll = false;
function watchScroll() {
  if (watchingScroll || typeof window === 'undefined') return;
  watchingScroll = true;
  window.addEventListener('scroll', () => { lastScrollAt = performance.now(); }, { capture: true, passive: true });
}

export function useHoverPreview<T>(delayMs = HOVER_PREVIEW_DELAY_MS) {
  const [preview, setPreview] = useState<EntityHoverPreview<T> | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    for (const ref of [showTimerRef, closeTimerRef]) {
      if (ref.current == null) continue;
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const onEnter = useCallback(
    (data: T, anchor: HTMLElement) => {
      clearTimers();
      watchScroll();
      const enteredAt = performance.now();
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (lastScrollAt > enteredAt - SCROLL_REST_MS) return;
        if (anchor.isConnected) setPreview({ data, anchor });
      }, delayMs);
    },
    [clearTimers, delayMs],
  );

  const onLeave = useCallback(() => {
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPreview(null);
    }, HOVER_CARD_GRACE_MS);
  }, [clearTimers]);

  const dismiss = useCallback(() => {
    clearTimers();
    setPreview(null);
  }, [clearTimers]);

  // Shows at once: a ⋯ button or a keyboard request for the card.
  const open = useCallback((data: T, anchor: HTMLElement) => {
    clearTimers();
    if (anchor.isConnected) setPreview({ data, anchor });
  }, [clearTimers]);

  // The pointer reaching the card keeps it, and cancels a card pending for a
  // row it crossed on the way.
  const card = useMemo(() => ({ onMouseEnter: clearTimers, onMouseLeave: onLeave }), [clearTimers, onLeave]);

  useEffect(() => () => clearTimers(), [clearTimers]);
  return { preview, onEnter, onLeave, dismiss, open, card };
}
