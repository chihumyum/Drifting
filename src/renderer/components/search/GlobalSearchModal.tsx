import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { sql } from 'drizzle-orm';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { getDb } from '../../lib/db';
import { NodeContentTable } from '../../schema/drizzle';
import '../../../styles/search.css';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Pull plain text out of a Tiptap doc JSON. We only care about `text` leaves;
// block boundaries get joined with newlines so excerpts don't smash adjacent
// paragraphs together.
function extractTiptapText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: unknown; content?: unknown };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) {
    const joiner = n.type === 'doc' || n.type === undefined ? '\n' : '';
    return (n.content as unknown[]).map(extractTiptapText).join(joiner);
  }
  return '';
}

function safeParse(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Escape LIKE wildcards so a query containing % or _ doesn't broaden the match.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// -----------------------------------------------------------------------------
// Search shape
// -----------------------------------------------------------------------------

type SearchableEntityType = 'node' | 'storyline' | 'element' | 'category';
type Field = 'title' | 'name' | 'summary' | 'body';

interface Occurrence {
  field: Field;
  excerpt: string;
  matchStart: number; // index of the hit within `excerpt`
  matchLen: number;
}

interface EntityGroup {
  entityType: SearchableEntityType;
  entityId: string;
  entityTitle: string;
  occurrences: Occurrence[];
  // Number of additional matches we found but did not include (per-entity cap).
  truncated: number;
}

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const MAX_OCCURRENCES_PER_ENTITY = 30;
const EXCERPT_RADIUS = 28;

const ENTITY_LABEL_KEY: Record<SearchableEntityType, string> = {
  node: 'globalSearch.entity.node',
  storyline: 'globalSearch.entity.storyline',
  element: 'globalSearch.entity.element',
  category: 'globalSearch.entity.category',
};

const ENTITY_ICON: Record<SearchableEntityType, string> = {
  node: '§',
  storyline: '¶',
  element: '◆',
  category: '⌘',
};

const FIELD_LABEL_KEY: Record<Field, string> = {
  title: 'globalSearch.field.title',
  name: 'globalSearch.field.name',
  summary: 'globalSearch.field.summary',
  body: 'globalSearch.field.body',
};

// Find every occurrence of `q` in `text`, up to `cap` returned. The full count
// (including those past the cap) is returned in `total` so callers can show a
// "more …" tail.
function findOccurrences(
  text: string,
  q: string,
  field: Field,
  cap: number,
): { occurrences: Occurrence[]; total: number } {
  if (!text || !q) return { occurrences: [], total: 0 };
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const occurrences: Occurrence[] = [];
  let total = 0;
  let from = 0;
  while (true) {
    const i = lower.indexOf(lq, from);
    if (i < 0) break;
    total++;
    if (occurrences.length < cap) {
      const start = Math.max(0, i - EXCERPT_RADIUS);
      const end = Math.min(text.length, i + lq.length + EXCERPT_RADIUS);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      const raw = prefix + text.slice(start, end) + suffix;
      const excerpt = raw.replace(/\s+/g, ' ').trim();
      const ms = excerpt.toLowerCase().indexOf(lq);
      if (ms >= 0) {
        occurrences.push({ field, excerpt, matchStart: ms, matchLen: q.length });
      }
    }
    from = i + Math.max(1, lq.length);
  }
  return { occurrences, total };
}

// Combine occurrences across an entity's searchable fields, respecting the
// per-entity cap. Returns null if nothing matched.
function buildGroup(
  entityType: SearchableEntityType,
  entityId: string,
  entityTitle: string,
  fields: Array<{ field: Field; text: string }>,
  q: string,
): EntityGroup | null {
  const occurrences: Occurrence[] = [];
  let total = 0;
  for (const f of fields) {
    const cap = Math.max(0, MAX_OCCURRENCES_PER_ENTITY - occurrences.length);
    const res = findOccurrences(f.text, q, f.field, cap);
    occurrences.push(...res.occurrences);
    total += res.total;
  }
  if (occurrences.length === 0) return null;
  return {
    entityType,
    entityId,
    entityTitle,
    occurrences,
    truncated: Math.max(0, total - occurrences.length),
  };
}

// -----------------------------------------------------------------------------
// Render helpers
// -----------------------------------------------------------------------------

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="gsearch-mark">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function renderOccurrence(o: Occurrence): React.ReactNode {
  const { excerpt, matchStart, matchLen } = o;
  return (
    <>
      {excerpt.slice(0, matchStart)}
      <mark className="gsearch-mark">
        {excerpt.slice(matchStart, matchStart + matchLen)}
      </mark>
      {excerpt.slice(matchStart + matchLen)}
    </>
  );
}

// -----------------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------------

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { openEntity } = useProjectNavigation();
  const bookNodes = useDataStore((s) => s.bookNodes);
  const storylines = useDataStore((s) => s.storylines);
  const bookElements = useDataStore((s) => s.bookElements);
  const categories = useDataStore((s) => s.bookElementCategories);

  // Reset state and focus the input each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIdx(0);
    setGroups([]);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  // Search pipeline: debounced async pass that
  //   1) pre-fetches node body JSON (LIKE-prefiltered to rows that might match),
  //   2) walks every entity once, gathering all occurrences across all fields,
  //   3) builds one EntityGroup per matching entity.
  // No dedupe: a single entity can produce many occurrences; callers see them
  // all (capped per-entity).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const nodeBodies = new Map<string, string>();
      try {
        const pat = `%${escapeLike(q)}%`;
        const patLow = `%${escapeLike(q.toLowerCase())}%`;
        const rows = await getDb()
          .select({
            nodeId: NodeContentTable.nodeId,
            contentJson: NodeContentTable.contentJson,
          })
          .from(NodeContentTable)
          .where(
            sql`lower(${NodeContentTable.contentJson}) LIKE ${patLow} ESCAPE '\\' OR ${NodeContentTable.contentJson} LIKE ${pat} ESCAPE '\\'`,
          );
        if (cancelled) return;
        for (const r of rows) {
          if (r.contentJson) nodeBodies.set(r.nodeId, r.contentJson);
        }
      } catch {
        // DB not initialized — node body search is skipped, metadata still works.
      }

      const next: EntityGroup[] = [];

      for (const n of bookNodes) {
        const bodyJson = nodeBodies.get(n.id);
        const bodyText = bodyJson ? extractTiptapText(safeParse(bodyJson)) : '';
        const g = buildGroup(
          'node',
          n.id,
          n.title || t('globalSearch.fallback.untitled'),
          [
            { field: 'title', text: n.title || '' },
            { field: 'summary', text: n.summary || '' },
            { field: 'body', text: bodyText },
          ],
          q,
        );
        if (g) next.push(g);
      }
      for (const s of storylines) {
        const bodyText = extractTiptapText(safeParse(s.contentJson));
        const g = buildGroup(
          'storyline',
          s.id,
          s.name || t('globalSearch.fallback.untitled'),
          [
            { field: 'name', text: s.name || '' },
            { field: 'summary', text: s.summary || '' },
            { field: 'body', text: bodyText },
          ],
          q,
        );
        if (g) next.push(g);
      }
      for (const e of bookElements) {
        const bodyText = extractTiptapText(safeParse(e.contentJson));
        const g = buildGroup(
          'element',
          e.id,
          e.name || t('globalSearch.fallback.unnamed'),
          [
            { field: 'name', text: e.name || '' },
            { field: 'summary', text: e.summary || '' },
            { field: 'body', text: bodyText },
          ],
          q,
        );
        if (g) next.push(g);
      }
      for (const c of categories) {
        const bodyText = extractTiptapText(safeParse(c.contentJson));
        const g = buildGroup(
          'category',
          c.id,
          c.name || t('globalSearch.fallback.unnamed'),
          [
            { field: 'name', text: c.name || '' },
            { field: 'body', text: bodyText },
          ],
          q,
        );
        if (g) next.push(g);
      }

      if (!cancelled) setGroups(next);
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, bookNodes, storylines, bookElements, categories, t]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Flatten occurrences for arrow-key navigation. Group headers are decorative
  // and not part of the cursor sequence.
  const flatItems = useMemo(() => {
    const arr: Array<{ groupIdx: number; occIdx: number }> = [];
    groups.forEach((g, gi) =>
      g.occurrences.forEach((_, oi) => arr.push({ groupIdx: gi, occIdx: oi })),
    );
    return arr;
  }, [groups]);

  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const g of groups) {
      offsets.push(acc);
      acc += g.occurrences.length;
    }
    return offsets;
  }, [groups]);

  const totalOccurrences = flatItems.length;

  // Scroll the selected occurrence into view as it changes.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-occurrence-index="${selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  if (!isOpen) return null;

  const choose = (group: EntityGroup) => {
    onClose();
    openEntity(
      { entityType: group.entityType, id: group.entityId },
      { preview: false },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (totalOccurrences > 0) {
        setSelectedIdx((prev) => (prev + 1) % totalOccurrences);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (totalOccurrences > 0) {
        setSelectedIdx((prev) => (prev - 1 + totalOccurrences) % totalOccurrences);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const flat = flatItems[selectedIdx];
      if (!flat) return;
      const group = groups[flat.groupIdx];
      if (group) choose(group);
    }
  };

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && groups.length === 0;

  return (
    <div className="gsearch-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="gsearch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gsearch-header">
          <Search size={15} />
          <input
            ref={inputRef}
            className="gsearch-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('globalSearch.placeholder')}
          />
          {hasQuery && (
            <span className="gsearch-stats">
              {t('globalSearch.stats', {
                groups: groups.length,
                occurrences: totalOccurrences,
              })}
            </span>
          )}
          <button
            type="button"
            className="gsearch-close-btn"
            onClick={onClose}
            title={t('globalSearch.closeTitle')}
          >
            <X size={13} />
          </button>
        </div>

        <div
          ref={listRef}
          className={`gsearch-results${noResults || !hasQuery ? ' is-empty-state' : ''}`}
        >
          {!hasQuery && (
            <div className="gsearch-empty">{t('globalSearch.emptyPrompt')}</div>
          )}
          {noResults && <div className="gsearch-empty">{t('globalSearch.noResults')}</div>}
          {groups.map((g, gi) => (
            <div key={`${g.entityType}:${g.entityId}`} className="gsearch-group">
              <div className="gsearch-group-header" onClick={() => choose(g)}>
                <span className="gsearch-group-icon">{ENTITY_ICON[g.entityType]}</span>
                <span className="gsearch-group-title">
                  {highlight(g.entityTitle, query)}
                </span>
                <span className="gsearch-count">
                  {g.truncated > 0
                    ? `${g.occurrences.length}+${g.truncated}`
                    : g.occurrences.length}
                </span>
                <span className="gsearch-kind">{t(ENTITY_LABEL_KEY[g.entityType])}</span>
              </div>
              {g.occurrences.map((o, oi) => {
                const flatIdx = groupOffsets[gi] + oi;
                const active = flatIdx === selectedIdx;
                return (
                  <div
                    key={oi}
                    data-occurrence-index={flatIdx}
                    className={`gsearch-row${active ? ' is-active' : ''}`}
                    onMouseEnter={() => setSelectedIdx(flatIdx)}
                    onClick={() => choose(g)}
                  >
                    <span className="gsearch-field-tag">{t(FIELD_LABEL_KEY[o.field])}</span>
                    <span className="gsearch-excerpt">{renderOccurrence(o)}</span>
                  </div>
                );
              })}
              {g.truncated > 0 && (
                <div className="gsearch-truncated">
                  {t('globalSearch.truncated', { count: g.truncated })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
