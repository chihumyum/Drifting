import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { NodeContent } from '../../domain/node-content';
import {
  applyBookFindHighlights,
  clearBookFindHighlights,
  collectBookMatches,
  containerForMatch,
  type ChapterDoc,
} from '../../lib/all-chapters-find';
import { FindResultsList, type FindResultRow } from './FindResultsList';
import { FindToolbar } from './FindToolbar';
import '../../../styles/search.css';

// Title/summary/contentJson are snapshotted from the chapter nodes; contentJson
// is fetched lazily (cache-hit fast) when the panel opens.
export interface FindChapter {
  nodeId: string;
  index: number;
  title: string;
  summary: string;
}

interface AllChaptersFindPanelProps {
  // The read-through scroll container — search + highlight + scroll are all
  // scoped to it (so a split pane elsewhere is never touched).
  scrollRef: React.RefObject<HTMLDivElement | null>;
  // Every chapter in reading order. Stable reference from the view.
  chapters: FindChapter[];
  fetchContent: (nodeId: string) => Promise<NodeContent | null>;
  // Bumped each time the user presses Cmd+F — re-focuses + selects the input so
  // a repeat press while the panel is already open behaves like the browser's
  // native find (focus the field, select its text).
  focusNonce: number;
  onClose: () => void;
}

// Whole-book Cmd+F for 通览全书. Searches every chapter's title, summary and
// prose (not other entities — that's the global search modal), highlights all
// hits across live + static + offscreen rows via the CSS Custom Highlight API,
// and steps through them with Enter / arrows without promoting any row to an
// editor (pure read-through navigation).
export function AllChaptersFindPanel({
  scrollRef,
  chapters,
  fetchContent,
  focusNonce,
  onClose,
}: AllChaptersFindPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [docs, setDocs] = useState<ChapterDoc[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build searchable docs when the panel opens / the chapter set changes. Every
  // chapter is fetched up front (cache hits are effectively synchronous), so a
  // match in a chapter the user has never scrolled to is still found.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const built = await Promise.all(
        chapters.map(async (c) => {
          let contentJson: string | null = null;
          try {
            contentJson = (await fetchContent(c.nodeId))?.contentJson ?? null;
          } catch {
            contentJson = null;
          }
          return { nodeId: c.nodeId, index: c.index, title: c.title, summary: c.summary, contentJson };
        }),
      );
      if (!cancelled) setDocs(built);
    })();
    return () => {
      cancelled = true;
    };
  }, [chapters, fetchContent]);

  // Focus + select on mount and on each Cmd+F repeat (focusNonce bump).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  const matches = useMemo(() => collectBookMatches(query, docs), [query, docs]);
  // currentIndex can transiently outrun the match set (e.g. the doc set
  // shrinks). Clamp for everything that reads it so display / highlight / nav
  // stay in range without an extra reset render.
  const safeIndex = matches.length === 0 ? 0 : Math.min(currentIndex, matches.length - 1);

  // Results list rows, grouped by chapter (in reading order, since matches
  // already are). Each carries its match index so a click maps back to jumpTo.
  const titleByNode = useMemo(
    () => new Map(chapters.map((c) => [c.nodeId, c.title])),
    [chapters],
  );
  const resultRows = useMemo<FindResultRow[]>(
    () =>
      matches.map((m, i) => ({
        index: i,
        groupKey: m.nodeId,
        groupLabel: titleByNode.get(m.nodeId) || t('findPanel.untitledChapter'),
        excerpt: m.excerpt.text,
        matchStart: m.excerpt.matchStart,
        matchEnd: m.excerpt.matchEnd,
      })),
    [matches, titleByNode, t],
  );

  // Scroll a match's container into view; if its row hasn't rendered yet, fall
  // back to scrolling the chapter section (which renders it), then the next
  // repaint lights up the current hit.
  const scrollMatchIntoView = useCallback(
    (index: number) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      const m = matches[index];
      if (!m) return;
      const el = containerForMatch(scrollEl, m);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const section = scrollEl.querySelector<HTMLElement>(
        `[data-chapter-id="${CSS.escape(m.nodeId)}"]`,
      );
      section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [matches, scrollRef],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const wrapped = ((index % matches.length) + matches.length) % matches.length;
      setCurrentIndex(wrapped);
      scrollMatchIntoView(wrapped);
    },
    [matches.length, scrollMatchIntoView],
  );

  // On a new query, jump to the first hit (index reset lives in the input's
  // onChange so it's not a setState-in-effect). No-op while matches are empty.
  useEffect(() => {
    if (query) scrollMatchIntoView(0);
    // Re-run only when the query changes, not when scrollMatchIntoView's identity
    // churns (it depends on the freshly-recomputed matches).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Repaint highlights on change, and keep a stable ref to the latest painter so
  // the (mount-stable) scroll listener can call it without re-binding.
  const repaintRef = useRef<() => void>(() => {});
  useEffect(() => {
    repaintRef.current = () => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      applyBookFindHighlights(scrollEl, query, matches, safeIndex);
    };
    repaintRef.current();
  }, [query, matches, safeIndex, scrollRef]);

  // Lazy rows render as they scroll into view, so re-resolve + repaint after the
  // scroll settles — that's what lights up matches in chapters that weren't
  // rendered when the query ran. Clears the highlight on unmount.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        repaintRef.current();
      }, 140);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      if (timer != null) window.clearTimeout(timer);
      // Tear down both highlight registrations when the panel closes.
      clearBookFindHighlights();
    };
  }, [scrollRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      jumpTo(e.shiftKey ? safeIndex - 1 : safeIndex + 1);
    }
  };

  const noMatches = matches.length === 0;

  return (
    <div
      className="editor-find-dock"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <FindToolbar
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCurrentIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('findPanel.bookPlaceholder')}
          stats={
            noMatches
              ? query
                ? '0/0'
                : t('findPanel.wholeBook')
              : `${safeIndex + 1}/${matches.length}`
          }
          noMatches={noMatches}
          onPrevious={() => jumpTo(safeIndex - 1)}
          onNext={() => jumpTo(safeIndex + 1)}
          onClose={onClose}
          previousTitle={t('findPanel.previousTitle')}
          nextTitle={t('findPanel.nextTitle')}
          closeTitle={t('findPanel.closeTitle')}
        />

      <FindResultsList
        rows={resultRows}
        activeIndex={safeIndex}
        onPick={jumpTo}
        showGroups
        totalCount={matches.length}
      />
    </div>
  );
}
