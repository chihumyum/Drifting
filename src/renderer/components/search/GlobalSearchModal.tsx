import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useGlobalSearchResults } from './use-global-search-results';
import type { SearchableEntityType, Field, Occurrence, EntityGroup } from './global-search-model';
import '../../../styles/search.css';
import { BrushIcon } from '../ui/BrushIcon';
import { KindMark } from '../ui/KindMark';
import type { KindMarkKind } from '../ui/kind-mark';

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

const ENTITY_MARK: Record<SearchableEntityType, KindMarkKind> = {
  node: 'chapter',
  storyline: 'storyline',
  element: 'element',
  category: 'category',
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
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const { rows, flatItems } = useMemo(() => {
    const rows: Array<{ groupIdx: number; occIdx: number; flatIdx: number }> = [];
    const flatItems: Array<{ groupIdx: number; occIdx: number; rowIdx: number }> = [];
    groups.forEach((group, groupIdx) => {
      rows.push({ groupIdx, occIdx: -1, flatIdx: -1 });
      group.occurrences.forEach((_, occIdx) => {
        const flatIdx = flatItems.length;
        flatItems.push({ groupIdx, occIdx, rowIdx: rows.length });
        rows.push({ groupIdx, occIdx, flatIdx });
      });
    });
    return { rows, flatItems };
  }, [groups]);
  const totalOccurrences = groups.reduce((total, group) => total + group.occurrences.length + group.truncated, 0);
  const navigableCount = flatItems.length;
  const rowHeight = 32;
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - 5);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + 5);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => setViewport({ top: list.scrollTop, height: list.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(list); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const list = listRef.current;
    const item = flatItems[selectedIdx];
    if (!list || !item) return;
    const top = item.rowIdx * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
    setViewport({ top: list.scrollTop, height: list.clientHeight });
  }, [selectedIdx, flatItems]);

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
      if (navigableCount > 0) {
        setSelectedIdx((prev) => (prev + 1) % navigableCount);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (navigableCount > 0) {
        setSelectedIdx((prev) => (prev - 1 + navigableCount) % navigableCount);
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
          <BrushIcon name="search" size={15} />
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
            <BrushIcon name="close" size={13} />
          </button>
        </div>

        <div
          ref={listRef}
          onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
          className={`gsearch-results${noResults || !hasQuery ? ' is-empty-state' : ''}`}
        >
          {!hasQuery && (
            <div className="gsearch-empty">{t('globalSearch.emptyPrompt')}</div>
          )}
          {noResults && <div className="gsearch-empty">{t('globalSearch.noResults')}</div>}
          {rows.length > 0 && <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
            {rows.slice(start, end).map((row, offset) => {
              const g = groups[row.groupIdx];
              const drift = g.nodeKind === 'drift';
              const style = { position: 'absolute' as const, top: (start + offset) * rowHeight, height: rowHeight, boxSizing: 'border-box' as const, left: 0, right: 0 };
              if (row.occIdx < 0) return (
                <div key={`${g.entityType}:${g.entityId}:header`} style={style} className="gsearch-group-header" onClick={() => choose(g)}>
                  <span className="gsearch-group-icon"><KindMark kind={drift ? 'drift' : ENTITY_MARK[g.entityType]} seed={g.entityId} /></span>
                  <span className="gsearch-group-title">{highlight(g.entityTitle, query)}</span>
                  <span className="gsearch-count">{g.occurrences.length + g.truncated}</span>
                  <span className="gsearch-kind">{t(drift ? 'nodeEditor.folio.drift' : ENTITY_LABEL_KEY[g.entityType])}</span>
                </div>
              );
              const o = g.occurrences[row.occIdx];
              return (
                <div key={`${g.entityType}:${g.entityId}:${row.occIdx}`} style={style}
                  data-occurrence-index={row.flatIdx}
                  className={`gsearch-row${row.flatIdx === selectedIdx ? ' is-active' : ''}`}
                  onMouseEnter={() => setSelectedIdx(row.flatIdx)} onClick={() => choose(g)}>
                  <span className="gsearch-field-tag">{t(FIELD_LABEL_KEY[o.field])}</span>
                  <span className="gsearch-excerpt">{renderOccurrence(o)}</span>
                </div>
              );
            })}
          </div>}

        </div>
      </div>
    </div>
  );
}
