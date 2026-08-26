import { ArrowLeft, Search, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { MobileTabBar, type MobileTabBarTab } from './MobileTabBar';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useMobileProjectSearch } from './useMobileProjectSearch';
import type { MobileProjectSearchOccurrence } from './mobile-project-search';
import { useDataStore } from '../../../store/data-store';
import { isDrift } from '../../../domain/book-node';

export type { MobileSuperViewId } from './mobile-workspace-controller';

/** How many papers the single-row deck comfortably holds before the overview
 * switches to the two-row grid. */
const DECK_LIMIT = 4;

function SearchExcerpt({ occurrence }: { occurrence: MobileProjectSearchOccurrence }) {
  const before = occurrence.excerpt.slice(0, occurrence.matchStart);
  const match = occurrence.excerpt.slice(
    occurrence.matchStart,
    occurrence.matchStart + occurrence.matchLength,
  );
  const after = occurrence.excerpt.slice(occurrence.matchStart + occurrence.matchLength);
  return (
    <span>
      {before}<mark>{match}</mark>{after}
    </span>
  );
}

/** The workspace tab character for a paper's entity type — the same glyph
 * vocabulary as the desktop tabs (§ ❦ ¶ ◆ ⌘ ☰). */
function usePaperGlyph(target: WorkspaceTarget): string {
  const bookNodes = useDataStore((s) => s.bookNodes);
  switch (target.entityType) {
    case 'node': {
      const node = bookNodes.find((item) => item.id === target.id);
      return node && isDrift(node) ? '❦' : '§';
    }
    case 'storyline':
      return '¶';
    case 'element':
      return '◆';
    case 'category':
      return '⌘';
    case 'all-chapters':
      return '☰';
  }
}

function OverviewPaperCard({
  paper,
  active,
  showClose,
  onActivate,
  onClose,
}: {
  paper: MobilePaper;
  active: boolean;
  showClose: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const presentation = useMobilePaperPresentation(paper.target);
  const glyph = usePaperGlyph(paper.target);
  return (
    <article className="m-ov-card" data-active={active ? 'true' : 'false'}>
      {showClose && (
        <button
          type="button"
          className="m-ov-card__close"
          onClick={onClose}
          aria-label="Close paper"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
      <button type="button" className="m-ov-card__main" onClick={onActivate}>
        <small>
          <span aria-hidden="true">{glyph}</span> {presentation.kicker}
        </small>
        <strong>{presentation.title}</strong>
        <p>{presentation.preview}</p>
      </button>
    </article>
  );
}

/** Dots mirroring the paper layout: one dot per paper, a single row for the
 * deck, two column-major rows for the grid (an odd count leaves the last
 * column with its lone top dot, exactly like the papers themselves). */
function OverviewDots({ count, current, rows }: { count: number; current: number; rows: 1 | 2 }) {
  if (count < 2) return null;
  return (
    <span className="m-ov-dots" data-rows={rows} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} data-current={index === current ? 'true' : 'false'} />
      ))}
    </span>
  );
}

export function MobileTabOverview({
  session,
  searchQuery,
  onSearchQueryChange,
  onClose,
  onActivate,
  onActivateSearchResult,
  onClosePaper,
  onCloseAll,
  onOpenSettings,
  onOpenTrash,
  onOpenStructure,
}: {
  session: MobileWorkspaceSessionState;
  searchQuery: string | null;
  onSearchQueryChange: (query: string | null) => void;
  onClose: () => void;
  onActivate: (paper: MobilePaper) => void;
  onActivateSearchResult: (target: WorkspaceTarget) => void;
  onClosePaper: (key: string) => void;
  onCloseAll: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  onOpenStructure: (tab: MobileTabBarTab) => void;
}) {
  const { t } = useTranslation();
  const projectSearch = useMobileProjectSearch(searchQuery ?? '');
  const searchingProject = searchQuery !== null;
  const papers = session.papers;
  const layout: 'deck' | 'grid' = papers.length > DECK_LIMIT ? 'grid' : 'deck';
  const activeIndex = Math.max(
    0,
    papers.findIndex((paper) => paper.key === session.activeKey),
  );
  const [deckIndex, setDeckIndex] = useState(activeIndex);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const deckIndexRef = useRef(deckIndex);
  deckIndexRef.current = deckIndex;

  // Center the active paper when the deck opens; afterwards the scroll
  // position (not the session) decides which card carries the close control.
  useEffect(() => {
    if (layout !== 'deck') return;
    const deck = deckRef.current;
    if (!deck) return;
    const card = deck.children[activeIndex] as HTMLElement | undefined;
    if (!card) return;
    deck.scrollLeft = card.offsetLeft - (deck.clientWidth - card.clientWidth) / 2;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial centering seeds the indicator once per layout change
    setDeckIndex(activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only when the deck layout appears
  }, [layout]);

  const trackDeckScroll = () => {
    const deck = deckRef.current;
    if (!deck || deck.children.length === 0) return;
    const center = deck.scrollLeft + deck.clientWidth / 2;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < deck.children.length; index++) {
      const card = deck.children[index] as HTMLElement;
      const cardCenter = card.offsetLeft + card.clientWidth / 2;
      const distance = Math.abs(cardCenter - center);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    if (nearest !== deckIndexRef.current) setDeckIndex(nearest);
  };

  return (
    <section
      className="m-tab-overview"
      role="dialog"
      aria-modal="true"
      data-layout={layout}
      aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
    >
      <header>
        <button type="button" onClick={onClose} aria-label={t('navigation.back')}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        {searchingProject ? (
          <div>
            <label className="m-tab-overview__search">
              <Search size={16} aria-hidden="true" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder={t('globalSearch.placeholder')}
                aria-label={t('globalSearch.placeholder')}
              />
            </label>
          </div>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="m-tab-overview__header-end">
          {searchingProject ? (
            <button
              type="button"
              onClick={() => onSearchQueryChange(null)}
              aria-label={t('findPanel.closeTitle')}
            >
              <X size={19} aria-hidden="true" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onSearchQueryChange('')}
                aria-label={t('mobileWorkspace.search.open', { defaultValue: '搜索' })}
              >
                <Search size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label={t('settings.title')}
              >
                <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
              </button>
            </>
          )}
        </span>
      </header>

      <div className="m-tab-overview__scroll">
        {searchingProject ? (
          <section className="m-project-search" data-status={projectSearch.status}>
            <header>
              <span>{t('mobileWorkspace.search.projectScope', { defaultValue: '项目搜索' })}</span>
              <strong>{projectSearch.totalMatches}</strong>
            </header>
            {searchQuery.trim() === '' ? (
              <p>{t('globalSearch.emptyPrompt')}</p>
            ) : projectSearch.status === 'searching' ? (
              <p>{t('common.loading')}</p>
            ) : projectSearch.groups.length === 0 ? (
              <p>{t('globalSearch.noResults')}</p>
            ) : (
              <div className="m-project-search__groups">
                {projectSearch.groups.map((group) => (
                  <button
                    key={`${group.target.entityType}:${group.target.id}`}
                    type="button"
                    onClick={() => onActivateSearchResult(group.target)}
                  >
                    <span>
                      <strong>{group.title}</strong>
                      <em>{group.totalMatches}</em>
                    </span>
                    {group.occurrences.slice(0, 3).map((occurrence, index) => (
                      <SearchExcerpt key={`${occurrence.field}:${index}`} occurrence={occurrence} />
                    ))}
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : papers.length === 0 ? (
          <div className="m-ov-empty">
            <strong>{t('mobileWorkspace.noPapers', { defaultValue: '没有打开的纸张' })}</strong>
            <span>
              {t('mobileWorkspace.overviewEmptyHint', {
                defaultValue: '从下方的章节、元素或灵感打开一张纸。',
              })}
            </span>
          </div>
        ) : layout === 'deck' ? (
          <div className="m-ov-stage">
            <div className="m-ov-deck" ref={deckRef} onScroll={trackDeckScroll}>
              {papers.map((paper, index) => (
                <OverviewPaperCard
                  key={paper.key}
                  paper={paper}
                  active={paper.key === session.activeKey}
                  showClose={index === deckIndex}
                  onActivate={() => onActivate(paper)}
                  onClose={() => onClosePaper(paper.key)}
                />
              ))}
            </div>
            <OverviewDots count={papers.length} current={deckIndex} rows={1} />
          </div>
        ) : (
          <div className="m-ov-stage">
            <div className="m-ov-grid">
              {papers.map((paper) => (
                <OverviewPaperCard
                  key={paper.key}
                  paper={paper}
                  active={paper.key === session.activeKey}
                  showClose
                  onActivate={() => onActivate(paper)}
                  onClose={() => onClosePaper(paper.key)}
                />
              ))}
            </div>
            <OverviewDots count={papers.length} current={activeIndex} rows={2} />
          </div>
        )}
      </div>

      {!searchingProject && papers.length > 0 && (
        <div className="m-ov-actions">
          <button type="button" onClick={onCloseAll}>
            {t('mobileWorkspace.closeAll', { defaultValue: '全部关闭' })}
          </button>
          <button type="button" onClick={onOpenTrash}>
            {t('settings.rail.trash')}
          </button>
        </div>
      )}

      <MobileTabBar hidden={searchingProject} onOpen={onOpenStructure} />
    </section>
  );
}
