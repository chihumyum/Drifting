import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deriveStatus,
  hasCanonicalWordCount,
  isChapter,
  type DerivedStatus,
} from '../../domain/book-node';
import { deriveActSegments, type BookAct } from '../../domain/book-act';
import { useDataStore } from '../../store/data-store';
import { useWritingStatsStore } from '../../store/writing-stats-store';
import { EmptyState } from '../../components/ui/EmptyState';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import {
  MetaGrid,
  MetaK,
  MetaV,
  Notes,
  ProgressBar,
  StatsLinkRow,
  StatsRow,
  StatsSection,
} from './StatsPrimitives';

// ─────────────────────────────────────────────────────────────────────────────
// All-chapters (长卷阅读) aggregate stats — book-wide pacing, NOT a per-entity
// panel. Deliberately a different lens from the project dashboard: it describes
// the linear reading axis (act balance, chapter-length rhythm) the long-form
// view renders, rather than project-management progress. Everything here is
// derived from already-loaded store data — no async queries.

const ALL_CHAPTERS_ACT_TOKENS = [
  '--story-1',
  '--story-2',
  '--story-3',
  '--story-4',
  '--story-5',
  '--story-6',
] as const;

/** An act's stored color, or a stable hue cycled by reading position. */
function actColorAt(act: BookAct, i: number): string {
  if (act.color && act.color.trim().length > 0) return act.color;
  return `hsl(var(${ALL_CHAPTERS_ACT_TOKENS[i % ALL_CHAPTERS_ACT_TOKENS.length]}))`;
}

/**
 * Smooth-scroll the long-form reading view to an act divider / chapter. That
 * scroll container lives in AllChaptersEditorView; scrollIntoView walks
 * ancestors, so a document-level lookup reaches it without threading a ref
 * across the panel boundary. No-op if the row isn't mounted yet (lazy rows).
 */
function scrollReadingViewTo(selector: string) {
  const el = document.querySelector(selector);
  if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

type RhythmChapter = { id: string; title?: string | null; wordCount?: number | null };

/**
 * Chapter-length rhythm — one horizontal bar per chapter, laid out as a
 * vertical list so it scales to any chapter count without the bars thinning to
 * unhoverable slivers; each bar's width is scaled to the longest chapter.
 * Hovering a bar reads its title + word count out in the caption below and dims
 * the rest; clicking smooth-scrolls the long-form reading view to that chapter,
 * reusing the same jump path as the act rows and the TOC.
 */
function ChapterRhythmChart({
  chapters,
  maxWc,
  colorByChapter,
  longest,
  shortest,
}: {
  chapters: RhythmChapter[];
  maxWc: number;
  colorByChapter: Map<string, string>;
  longest: RhythmChapter | null;
  shortest: RhythmChapter | null;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered != null ? chapters[hovered] : null;
  const untitled = t('common.untitled');

  return (
    <>
      <div style={{ padding: '2px 0' }} onMouseLeave={() => setHovered(null)}>
        {chapters.map((n, i) => {
          const w = maxWc > 0 ? Math.max(2, ((n.wordCount || 0) / maxWc) * 100) : 2;
          const isHovered = hovered === i;
          return (
            <div
              key={n.id}
              role="button"
              tabIndex={-1}
              title={t('rightSidebar.stats.jumpTo', { name: n.title || untitled })}
              onMouseEnter={() => setHovered(i)}
              onClick={() => scrollReadingViewTo(`[data-chapter-id="${CSS.escape(n.id)}"]`)}
              // Contiguous full-width rows (no gaps) keep the whole column a
              // single easy hover/click strip; the visible bar stays thin.
              style={{
                padding: '1px 0',
                cursor: 'pointer',
                opacity: hovered == null ? 0.85 : isHovered ? 1 : 0.3,
                transition: 'opacity 0.12s ease',
              }}
            >
              <div
                style={{
                  width: `${w}%`,
                  minWidth: 2,
                  height: 3,
                  background: colorByChapter.get(n.id) || 'hsl(var(--ink-4))',
                  borderRadius: 1,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        // Reserve two lines so the readout swapping in on hover doesn't shift
        // the layout.
        style={{
          marginTop: 8,
          minHeight: 34,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-3))',
          lineHeight: 1.7,
        }}
      >
        {active ? (
          <div style={{ color: 'hsl(var(--ink-1))' }}>
            {t('rightSidebar.stats.titleWithWords', {
              title: active.title || untitled,
              words: (active.wordCount || 0).toLocaleString(),
            })}
          </div>
        ) : longest ? (
          <>
            <div>
              {t('rightSidebar.stats.longestWithWords', {
                title: longest.title || untitled,
                words: (longest.wordCount || 0).toLocaleString(),
              })}
            </div>
            {shortest && shortest.id !== longest.id && (
              <div>
                {t('rightSidebar.stats.shortestWithWords', {
                  title: shortest.title || untitled,
                  words: (shortest.wordCount || 0).toLocaleString(),
                })}
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

const STATUS_BUCKET_ORDER = ['done', 'draft', 'todo'] as const;
const STATUS_BUCKET_LABEL_KEY: Record<DerivedStatus, string> = {
  done: 'rightSidebar.status.done',
  draft: 'rightSidebar.status.draft',
  todo: 'rightSidebar.status.todo',
  discarded: 'rightSidebar.status.discarded',
};
const STATUS_BUCKET_OPACITY: Record<(typeof STATUS_BUCKET_ORDER)[number], number> = {
  done: 1,
  draft: 0.5,
  todo: 0.18,
};

export function AllChaptersStats({
  bookNodes,
  bookActs,
}: {
  bookNodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
  bookActs: ReturnType<typeof useDataStore.getState>['bookActs'];
}) {
  const { t } = useTranslation();
  const { projectId } = useWorkspaceNavigator();
  const projectWordTarget = useWritingStatsStore((s) =>
    projectId ? s.plans[projectId]?.projectWordTarget : undefined,
  );

  // Reading order = chapters only (drifts live off the bookOrder axis), sorted
  // by bookOrder. Mirrors AllChaptersEditorView so the stats describe exactly
  // what the long-form view puts on screen.
  const chapters = useMemo(
    () => bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );
  type Ch = (typeof chapters)[number];

  const totalWc = useMemo(() => chapters.reduce((a, n) => a + (n.wordCount || 0), 0), [chapters]);
  const count = chapters.length;
  const metricsReady = chapters.every(hasCanonicalWordCount);
  const avgWc = count ? Math.round(totalWc / count) : 0;
  const targetPct =
    projectWordTarget && projectWordTarget > 0
      ? Math.min(100, (totalWc / projectWordTarget) * 100)
      : null;

  const segments = useMemo(() => deriveActSegments(bookActs, chapters), [bookActs, chapters]);

  // Per-act aggregates + a chapterId→color map that ties the act bar and the
  // chapter-rhythm bars to one palette.
  const { actRows, colorByChapter } = useMemo(() => {
    const rows = segments.map((seg, i) => {
      const words = seg.chapters.reduce((a, c) => a + (c.wordCount || 0), 0);
      const cnt = seg.chapters.length;
      return {
        act: seg.act,
        color: actColorAt(seg.act, i),
        words,
        cnt,
        pct: totalWc ? (words / totalWc) * 100 : 0,
      };
    });
    const map = new Map<string, string>();
    rows.forEach((r, i) => {
      for (const c of segments[i].chapters) map.set(c.id, r.color);
    });
    return { actRows: rows, colorByChapter: map };
  }, [segments, totalWc]);

  // Chapter-length rhythm: bars scaled to the longest chapter, floored so a
  // zero/short chapter still shows a sliver.
  const maxWc = useMemo(
    () => chapters.reduce((m, n) => Math.max(m, n.wordCount || 0), 0),
    [chapters],
  );
  const { longest, shortest } = useMemo(() => {
    let lo: Ch | null = null;
    let sh: Ch | null = null;
    for (const n of chapters) {
      if (!lo || (n.wordCount || 0) > (lo.wordCount || 0)) lo = n;
      if (!sh || (n.wordCount || 0) < (sh.wordCount || 0)) sh = n;
    }
    return { longest: lo, shortest: sh };
  }, [chapters]);

  const statusCounts = useMemo(() => {
    const m: Record<DerivedStatus, number> = { done: 0, draft: 0, todo: 0, discarded: 0 };
    for (const n of chapters) m[deriveStatus(n)] += 1;
    return m;
  }, [chapters]);
  const activeTotal = STATUS_BUCKET_ORDER.reduce((a, s) => a + statusCounts[s], 0);
  const donePct = count ? Math.round((statusCounts.done / count) * 100) : 0;

  if (count === 0) {
    return <EmptyState message={t('rightSidebar.stats.noChapters')} />;
  }

  if (!metricsReady) {
    return (
      <div style={{ padding: 12 }}>
        <StatsSection title={t('rightSidebar.stats.bookOverview')}>
          <MetaGrid>
            <MetaK>{t('rightSidebar.stats.totalWords')}</MetaK>
            <MetaV>{t('common.counting')}</MetaV>
            <MetaK>{t('rightSidebar.stats.chapterCount')}</MetaK>
            <MetaV>{t('rightSidebar.stats.chaptersValue', { count })}</MetaV>
          </MetaGrid>
        </StatsSection>
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.bookOverview')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.totalWords')}</MetaK>
          <MetaV>{t('rightSidebar.stats.wordsValue', { count: totalWc.toLocaleString() })}</MetaV>
          <MetaK>{t('rightSidebar.stats.chapterCount')}</MetaK>
          <MetaV>{t('rightSidebar.stats.chaptersValue', { count })}</MetaV>
          <MetaK>{t('rightSidebar.stats.averagePerChapter')}</MetaK>
          <MetaV>{t('rightSidebar.stats.wordsValue', { count: avgWc.toLocaleString() })}</MetaV>
        </MetaGrid>
        {targetPct != null && (
          <div style={{ marginTop: 8 }}>
            <StatsRow
              k={t('rightSidebar.stats.writtenTarget')}
              v={`${totalWc.toLocaleString()} / ${projectWordTarget!.toLocaleString()}`}
            >
              <ProgressBar pct={targetPct} />
            </StatsRow>
          </div>
        )}
      </StatsSection>

      {actRows.length > 0 && (
        <StatsSection title={t('rightSidebar.stats.actRhythm')} topBorder>
          <div
            style={{
              display: 'flex',
              height: 5,
              borderRadius: 2,
              overflow: 'hidden',
              background: 'hsl(var(--rule))',
              marginBottom: 10,
            }}
          >
            {actRows.map((r) =>
              r.pct > 0 ? (
                <div
                  key={r.act.id}
                  title={t('rightSidebar.stats.actTooltip', {
                    name: r.act.name,
                    chapters: r.cnt,
                    words: r.words.toLocaleString(),
                  })}
                  style={{ width: `${r.pct}%`, background: r.color }}
                />
              ) : null,
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {actRows.map((r) => (
              <StatsLinkRow
                key={r.act.id}
                name={r.act.name}
                color={r.color}
                meta={t('rightSidebar.stats.actMeta', {
                  chapters: r.cnt,
                  wordsK: (r.words / 1000).toFixed(1),
                  pct: Math.round(r.pct),
                })}
                title={t('rightSidebar.stats.jumpTo', { name: r.act.name })}
                onOpen={() => scrollReadingViewTo(`[data-act-id="${CSS.escape(r.act.id)}"]`)}
              />
            ))}
          </div>
        </StatsSection>
      )}

      <StatsSection title={t('rightSidebar.stats.completion')} topBorder>
        {activeTotal === 0 ? (
          <Notes>{t('rightSidebar.stats.noActiveProgress')}</Notes>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                height: 5,
                borderRadius: 2,
                overflow: 'hidden',
                background: 'hsl(var(--rule))',
                marginBottom: 8,
              }}
            >
              {STATUS_BUCKET_ORDER.map((s) =>
                statusCounts[s] > 0 ? (
                  <div
                    key={s}
                    title={t('rightSidebar.stats.statusCount', {
                      status: t(STATUS_BUCKET_LABEL_KEY[s]),
                      count: statusCounts[s],
                    })}
                    style={{
                      width: `${(statusCounts[s] / activeTotal) * 100}%`,
                      background: 'hsl(var(--accent))',
                      opacity: STATUS_BUCKET_OPACITY[s],
                    }}
                  />
                ) : null,
              )}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'hsl(var(--ink-3))',
                lineHeight: 1.7,
              }}
            >
              {STATUS_BUCKET_ORDER.filter((s) => statusCounts[s] > 0)
                .map((s) =>
                  t('rightSidebar.stats.statusCount', {
                    status: t(STATUS_BUCKET_LABEL_KEY[s]),
                    count: statusCounts[s],
                  }),
                )
                .join(' · ') || '—'}
              {statusCounts.discarded > 0 &&
                t('rightSidebar.stats.discardedParen', { count: statusCounts.discarded })}
            </div>
            <StatsRow k={t('rightSidebar.status.done')} v={`${donePct}%`} />
          </>
        )}
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.chapterLengthRhythm')} topBorder>
        <ChapterRhythmChart
          chapters={chapters}
          maxWc={maxWc}
          colorByChapter={colorByChapter}
          longest={longest}
          shortest={shortest}
        />
      </StatsSection>
    </div>
  );
}
