import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { TabEntityType } from '../../store/ui-store';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SearchResult {
  entityType: TabEntityType;
  id: string;
  title: string;
  subtitle?: string;
  match: string; // the field the match was found in
}

const ENTITY_LABEL: Record<TabEntityType, string> = {
  node: '章节',
  storyline: '故事线',
  element: '元素',
  category: '分类',
};

const ENTITY_ICON: Record<TabEntityType, string> = {
  node: '§',
  storyline: '¶',
  element: '◆',
  category: '⌘',
};

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark
        style={{
          background: 'rgba(184, 153, 104, 0.35)',
          color: 'inherit',
          padding: 0,
        }}
      >
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { openEntity } = useProjectNavigation();
  const bookNodes = useDataStore((s) => s.bookNodes);
  const storylines = useDataStore((s) => s.storylines);
  const bookElements = useDataStore((s) => s.bookElements);
  const categories = useDataStore((s) => s.bookElementCategories);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIdx(0);
    // Defer focus so the modal mounts first.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchResult[] = [];

    for (const n of bookNodes) {
      const title = n.title || '';
      const summary = n.summary || '';
      if (title.toLowerCase().includes(q)) {
        out.push({ entityType: 'node', id: n.id, title, subtitle: summary, match: 'title' });
      } else if (summary.toLowerCase().includes(q)) {
        out.push({ entityType: 'node', id: n.id, title, subtitle: summary, match: 'summary' });
      }
    }
    for (const s of storylines) {
      const name = s.name || '';
      const summary = s.summary || '';
      if (name.toLowerCase().includes(q)) {
        out.push({ entityType: 'storyline', id: s.id, title: name, subtitle: summary, match: 'name' });
      } else if (summary.toLowerCase().includes(q)) {
        out.push({ entityType: 'storyline', id: s.id, title: name, subtitle: summary, match: 'summary' });
      }
    }
    for (const e of bookElements) {
      const name = e.name || '';
      if (name.toLowerCase().includes(q)) {
        const cat = categories.find((c) => c.id === e.categoryId);
        out.push({
          entityType: 'element',
          id: e.id,
          title: name,
          subtitle: cat ? `分类：${cat.name}` : undefined,
          match: 'name',
        });
      }
    }
    for (const c of categories) {
      const name = c.name || '';
      if (name.toLowerCase().includes(q)) {
        out.push({ entityType: 'category', id: c.id, title: name, match: 'name' });
      }
    }
    return out.slice(0, 50);
  }, [query, bookNodes, storylines, bookElements, categories]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Scroll the selected row into view when it changes.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-result-index="${selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  if (!isOpen) return null;

  const choose = (result: SearchResult) => {
    onClose();
    openEntity({ entityType: result.entityType, id: result.id }, { preview: false });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIdx((prev) => (prev + 1) % results.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIdx((prev) => (prev - 1 + results.length) % results.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[selectedIdx];
      if (target) choose(target);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(35, 28, 20, 0.32)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 96,
        zIndex: 10000,
      }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          width: 560,
          maxHeight: '70vh',
          background: '#fefdfb',
          borderRadius: 12,
          border: '1px solid #e8dcc8',
          boxShadow: '0 24px 64px rgba(90, 74, 58, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: '1px solid #e8dcc8',
          }}
        >
          <Search size={16} color="#8b7355" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索章节、故事线、元素、分类…"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: 15,
              background: 'transparent',
              color: '#2a1a0a',
            }}
          />
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            style={{
              width: 24,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: '#8b7355',
              cursor: 'pointer',
              borderRadius: 4,
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: query.trim() && results.length === 0 ? '24px' : '8px',
          }}
        >
          {!query.trim() && (
            <div style={{ padding: 24, color: '#8b7355', fontSize: 13, textAlign: 'center' }}>
              输入关键字以搜索项目内的所有 entity
            </div>
          )}
          {query.trim() && results.length === 0 && (
            <div style={{ color: '#8b7355', fontSize: 13, textAlign: 'center' }}>
              没有找到匹配项
            </div>
          )}
          {results.map((r, i) => {
            const isActive = i === selectedIdx;
            return (
              <div
                key={`${r.entityType}:${r.id}`}
                data-result-index={i}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => choose(r)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: isActive ? '#f5f0e8' : 'transparent',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-serif), Georgia, serif',
                    fontStyle: 'italic',
                    fontSize: 16,
                    color: '#b89968',
                    width: 18,
                    textAlign: 'center',
                    flexShrink: 0,
                  }}
                >
                  {ENTITY_ICON[r.entityType]}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      color: '#2a1a0a',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {highlight(r.title || '(无标题)', query)}
                  </div>
                  {r.subtitle && (
                    <div
                      style={{
                        fontSize: 12,
                        color: '#8b7355',
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {highlight(r.subtitle, query)}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, color: '#a89274', flexShrink: 0 }}>
                  {ENTITY_LABEL[r.entityType]}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
