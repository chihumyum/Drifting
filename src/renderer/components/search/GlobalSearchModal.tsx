import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useGlobalSearchResults } from './use-global-search-results';
import type { SearchableEntityType, Field, Occurrence, EntityGroup } from './global-search-model';
import '../../../styles/search.css';

interface GlobalSearchModalProps { isOpen: boolean; onClose(): void }

/** Closing releases data subscriptions, pending searches and parsed bodies.
 * A different project gets a new search session even if the shell is retained. */
export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const { projectId } = useProjectNavigation();
  return isOpen ? <GlobalSearchSession key={projectId} projectId={projectId} onClose={onClose} /> : null;
}

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

function GlobalSearchSession({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { openEntity } = useProjectNavigation();
  const groups = useGlobalSearchResults(projectId, query);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);


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
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
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
