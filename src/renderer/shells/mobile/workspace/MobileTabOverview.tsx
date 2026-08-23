import { ArrowLeft, BookOpen, PanelsTopLeft, Search, Settings, Trash2, X } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { useMobilePaperPresentation } from './MobilePaperContent';
import type { MobileSuperViewId } from './mobile-workspace-controller';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useMobileProjectSearch } from './useMobileProjectSearch';
import type { MobileProjectSearchOccurrence } from './mobile-project-search';

export type { MobileSuperViewId } from './mobile-workspace-controller';

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

function PaperOverviewCard({
  paper,
  active,
  index,
  onActivate,
  onClose,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  paper: MobilePaper;
  active: boolean;
  index: number;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: (index: number) => void;
  onDragMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const presentation = useMobilePaperPresentation(paper.target);
  return (
    <article className="m-tab-card" data-index={index} data-active={active ? 'true' : 'false'}>
      <button
        type="button"
        className="m-tab-card__drag"
        aria-label="拖动纸张排序"
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          onDragStart(index);
        }}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span aria-hidden="true" />
      </button>
      <button
        type="button"
        className="m-tab-card__close"
        onClick={onClose}
        aria-label="Close paper"
      >
        <X size={17} />
      </button>
      <button type="button" className="m-tab-card__main" onClick={onActivate}>
        <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
        <small>{presentation.kicker}</small>
        <strong>{presentation.title}</strong>
        <p>{presentation.preview}</p>
      </button>
    </article>
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
  onReorder,
  onOpenSuperView,
  onOpenAllChapters,
  onOpenSettings,
  onOpenTrash,
  onBackToShelf,
}: {
  session: MobileWorkspaceSessionState;
  searchQuery: string | null;
  onSearchQueryChange: (query: string | null) => void;
  onClose: () => void;
  onActivate: (paper: MobilePaper) => void;
  onActivateSearchResult: (target: WorkspaceTarget) => void;
  onClosePaper: (key: string) => void;
  onCloseAll: () => void;
  onReorder: (from: number, to: number) => void;
  onOpenSuperView: (view: MobileSuperViewId) => void;
  onOpenAllChapters: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  onBackToShelf: () => void;
}) {
  const { t } = useTranslation();
  const draggingIndexRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const projectSearch = useMobileProjectSearch(searchQuery ?? '');
  const searchingProject = searchQuery !== null;
  const superViews: Array<{ id: MobileSuperViewId; label: string; meta: string }> = [
    { id: 'element', label: t('superElement.title'), meta: t('leftSidebar.tabs.elements') },
    { id: 'graph', label: t('storyGraph.title'), meta: t('dashboard.structure.storylines') },
    {
      id: 'memo-material',
      label: t('memoMaterial.super.title'),
      meta: t('rightSidebar.tabs.library'),
    },
  ];
  const moveDraggedCard = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const from = draggingIndexRef.current;
    if (from === null) return;
    const card = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('.m-tab-card[data-index]');
    const to = Number(card?.dataset.index);
    if (!Number.isInteger(to) || to === from) return;
    onReorder(from, to);
    draggingIndexRef.current = to;
  };
  const endCardDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    draggingIndexRef.current = null;
    setDragging(false);
  };
  return (
    <section
      className="m-tab-overview"
      role="dialog"
      aria-modal="true"
      data-dragging={dragging ? 'true' : 'false'}
      aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
    >
      <header>
        <button type="button" onClick={onClose} aria-label={t('navigation.back')}>
          <ArrowLeft size={20} />
        </button>
        <div>
          <span>Drifting</span>
          {searchingProject ? (
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
          ) : (
            <strong>{t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}</strong>
          )}
        </div>
        <button
          type="button"
          onClick={() => (searchingProject ? onSearchQueryChange(null) : onOpenSettings())}
          aria-label={searchingProject ? t('findPanel.closeTitle') : t('settings.title')}
        >
          {searchingProject ? <X size={19} /> : <Settings size={19} />}
        </button>
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
        ) : (
          <>
        <section className="m-tab-overview__super">
          <div>
            <span>SUPER VIEW</span>
            <small>{t('mobileWorkspace.projectPanoramas', { defaultValue: '项目全景' })}</small>
          </div>
          <div>
            {superViews.map((view) => (
              <button key={view.id} type="button" onClick={() => onOpenSuperView(view.id)}>
                <PanelsTopLeft size={18} aria-hidden="true" />
                <strong>{view.label}</strong>
                <small>{view.meta}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="m-tab-overview__papers">
          <header>
            <span>{session.papers.length} PAPERS</span>
            <div>
              {session.papers.length > 0 && (
                <button type="button" onClick={onCloseAll}>
                  <Trash2 size={15} />
                  {t('mobileWorkspace.closeAll', { defaultValue: '全部关闭' })}
                </button>
              )}
              <button type="button" onClick={onOpenAllChapters}>
                <BookOpen size={16} />
                {t('topTimeline.tabs.allChapters', { defaultValue: '通览全书' })}
              </button>
            </div>
          </header>
          <div>
            {session.papers.map((paper, index) => (
              <PaperOverviewCard
                key={paper.key}
                paper={paper}
                active={paper.key === session.activeKey}
                index={index}
                onActivate={() => onActivate(paper)}
                onClose={() => onClosePaper(paper.key)}
                onDragStart={(from) => {
                  draggingIndexRef.current = from;
                  setDragging(true);
                }}
                onDragMove={moveDraggedCard}
                onDragEnd={endCardDrag}
              />
            ))}
          </div>
        </section>
          </>
        )}
      </div>

      {!searchingProject && <footer>
        <button type="button" onClick={onOpenTrash}>
          <Trash2 size={17} aria-hidden="true" />
          {t('settings.rail.trash')}
        </button>
        <button type="button" onClick={onBackToShelf}>
          {t('projectPicker.backToShelf', { defaultValue: '返回书架' })}
        </button>
      </footer>}
    </section>
  );
}
