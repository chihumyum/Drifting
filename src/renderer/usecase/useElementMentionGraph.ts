import { useEffect, useMemo, useState } from 'react';
import type { BookElement } from '../domain/book-element';
import type { BookNode } from '../domain/book-node';
import { events } from '../lib/events';
import {
  readElementMentionGraphRows,
  type ElementMentionGraphRows,
} from '../sqlite-repo/element-mention-graph-repo';
import { useDataStore } from '../store/data-store';

export interface ElementMentionGraph {
  /** 每个要素：章节正文里的总提及次数，和每章的次数（键是章节 id） */
  elements: ReadonlyMap<string, { mentions: number; byChapter: ReadonlyMap<string, number> }>;
  /** 同段：键是 `${a}|${b}`（a < b 的字典序），值是两者同时出现的段数 */
  pairs: ReadonlyMap<string, number>;
}

/** Unordered pair key; the smaller id (JS string order) always comes first. */
export function elementMentionPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Pure fold of the aggregated SQL rows into the graph read by the view. */
export function buildElementMentionGraph(rows: ElementMentionGraphRows): ElementMentionGraph {
  const totals = new Map<string, number>();
  const byElement = new Map<string, Map<string, number>>();
  for (const { elementId, chapterId, mentions } of rows.chapterMentions) {
    if (mentions <= 0) continue;
    let chapters = byElement.get(elementId);
    if (!chapters) {
      chapters = new Map();
      byElement.set(elementId, chapters);
    }
    chapters.set(chapterId, (chapters.get(chapterId) ?? 0) + mentions);
    totals.set(elementId, (totals.get(elementId) ?? 0) + mentions);
  }
  const elements = new Map<string, { mentions: number; byChapter: ReadonlyMap<string, number> }>();
  for (const [elementId, byChapter] of byElement) {
    elements.set(elementId, { mentions: totals.get(elementId) ?? 0, byChapter });
  }
  const pairs = new Map<string, number>();
  for (const { elementA, elementB, blocks } of rows.pairs) {
    if (elementA === elementB || blocks <= 0) continue;
    // SQLite orders TEXT by bytes; re-key in JS order so lookups agree.
    const key = elementMentionPairKey(elementA, elementB);
    pairs.set(key, (pairs.get(key) ?? 0) + blocks);
  }
  return { elements, pairs };
}

/**
 * The query only counts live chapters and live elements. Trash/restore,
 * chapter<->drift moves and element creation change that scope without
 * necessarily rewriting inline_mention rows, so they are a second refresh
 * trigger next to `references:changed`. Trashed rows are already filtered out
 * of the store's live arrays.
 */
export function elementMentionScopeKey(
  bookNodes: readonly BookNode[],
  bookElements: readonly BookElement[],
): string {
  const chapters = bookNodes.filter((node) => node.kind === 'chapter').map((node) => node.id).sort();
  const elements = bookElements.map((element) => element.id).sort();
  return `${chapters.join(',')}\n${elements.join(',')}`;
}

/** Selector that recomputes the scope key only when the arrays change identity. */
function createScopeKeySelector() {
  let nodes: readonly BookNode[] | null = null;
  let elements: readonly BookElement[] | null = null;
  let key = '';
  return (state: { bookNodes: BookNode[]; bookElements: BookElement[] }): string => {
    if (state.bookNodes !== nodes || state.bookElements !== elements) {
      nodes = state.bookNodes;
      elements = state.bookElements;
      key = elementMentionScopeKey(nodes, elements);
    }
    return key;
  };
}

/** Index passes can land in quick succession while the author types. */
const REFRESH_COALESCE_MS = 250;

interface LoadedGraph {
  projectId: string;
  requestKey: string;
  graph: ElementMentionGraph | null;
}

/**
 * Project-wide element mention graph from chapter prose. Queries once when
 * enabled, then again after the reference index commits new mention rows
 * (`references:changed`) or the live chapter/element scope changes. The
 * returned graph keeps its identity until a refresh lands; while refreshing,
 * the previous graph stays visible and `loading` is true.
 */
export function useElementMentionGraph(
  projectId: string | undefined,
  enabled: boolean,
): { graph: ElementMentionGraph | null; loading: boolean } {
  const active = enabled && Boolean(projectId);
  const [selectScopeKey] = useState(createScopeKeySelector);
  const scopeKey = useDataStore((state) => (active ? selectScopeKey(state) : ''));
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadedGraph | null>(null);
  // Closing the view drops its graph, so reopening never shows mentions that
  // changed while nobody listened; it simply queries again.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setLoaded(null);
  }

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = (event: { projectId: string }) => {
      if (event.projectId !== projectId || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setRevision((value) => value + 1);
      }, REFRESH_COALESCE_MS);
    };
    events.on('references:changed', onChanged);
    return () => {
      events.off('references:changed', onChanged);
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, projectId]);

  const requestKey = `${revision}\n${scopeKey}`;
  useEffect(() => {
    if (!active || !projectId) return;
    let alive = true;
    readElementMentionGraphRows(projectId).then(
      (rows) => {
        if (alive) setLoaded({ projectId, requestKey, graph: buildElementMentionGraph(rows) });
      },
      () => {
        // Keep the last good graph; the next index pass or scope change retries.
        if (alive) {
          setLoaded((previous) => ({
            projectId,
            requestKey,
            graph: previous?.projectId === projectId ? previous.graph : null,
          }));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [active, projectId, requestKey]);

  const current = active && loaded?.projectId === projectId ? loaded : null;
  const graph = current?.graph ?? null;
  const loading = active && current?.requestKey !== requestKey;
  return useMemo(() => ({ graph, loading }), [graph, loading]);
}
