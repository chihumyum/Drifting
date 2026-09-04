import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  ArrowRight,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { User } from '../../../store/auth';
import type { ProjectSummary } from '../../../usecase/useProject';
import type { DecoratedRow } from '../../../views/ProjectPickerView';
import { UserAvatar, UserMenu } from '../../../components/topBars/UserMenu';
import { hostedAccountSettingsEnabled } from '../../../features/settings/hosted-settings-policy';
import {
  readMobileProjectShelfSession,
  updateMobileProjectShelfSession,
  type MobileProjectShelfFilter,
  type MobileProjectShelfView,
} from './mobile-project-shelf-session';

interface MobileProjectShelfContentProps {
  loading: boolean;
  rows: DecoratedRow[];
  allRows: DecoratedRow[];
  total: number;
  counts: Record<MobileProjectShelfFilter, number>;
  filter: MobileProjectShelfFilter;
  query: string;
  user: User | null;
  userInitial: string;
  avatarRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onMenuOpenChange: Dispatch<SetStateAction<boolean>>;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: MobileProjectShelfFilter) => void;
  onCreate: () => void;
  onSettings: () => void;
  onOpen: (project: ProjectSummary) => void;
  onEdit: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

/** The shelf has two explicit faces: an immersive, horizontally paged work and
 * a compact all-project overview. One persistent grid button toggles between
 * them; search opens and focuses the overview without masquerading as Back. */
export function MobileProjectShelfContent({
  loading,
  rows,
  allRows,
  total,
  counts,
  filter,
  query,
  user,
  userInitial,
  avatarRef,
  menuOpen,
  onMenuOpenChange,
  onQueryChange,
  onFilterChange,
  onCreate,
  onSettings,
  onOpen,
  onEdit,
  onDelete,
}: MobileProjectShelfContentProps) {
  const { t, i18n } = useTranslation();
  const [initialSession] = useState(readMobileProjectShelfSession);
  const [view, setView] = useState<MobileProjectShelfView>(initialSession.view);
  const [actionsProjectId, setActionsProjectId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const overviewRef = useRef<HTMLElement | null>(null);
  const overviewScrollTopRef = useRef(initialSession.overviewScrollTop);
  const focusedProjectIdRef = useRef(initialSession.focusedProjectId);
  const viewRef = useRef(view);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchOnOverviewRef = useRef(false);
  const isZh = i18n.language.startsWith('zh');
  const accountSettingsEnabled = hostedAccountSettingsEnabled();

  useEffect(() => {
    viewRef.current = view;
    if (view !== 'overview') return;
    const frame = window.requestAnimationFrame(() => {
      if (overviewRef.current) overviewRef.current.scrollTop = overviewScrollTopRef.current;
      if (focusSearchOnOverviewRef.current) {
        focusSearchOnOverviewRef.current = false;
        searchInputRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, rows.length, view]);

  useEffect(() => {
    if (view !== 'pager' || !pagerRef.current || allRows.length === 0) return;
    const savedIndex = allRows.findIndex(
      ({ project }) => project.id === focusedProjectIdRef.current,
    );
    const nextIndex = savedIndex >= 0 ? savedIndex : 0;
    pagerRef.current.scrollLeft = nextIndex * pagerRef.current.clientWidth;
    focusedProjectIdRef.current = allRows[nextIndex]?.project.id ?? null;
    setPageIndex(nextIndex);
  }, [allRows, view]);

  useEffect(
    () => () => {
      updateMobileProjectShelfSession({
        view: viewRef.current,
        focusedProjectId: focusedProjectIdRef.current,
        overviewScrollTop: overviewScrollTopRef.current,
      });
    },
    [],
  );

  const showOverview = (focusSearch = false) => {
    const currentProjectId = allRows[pageIndex]?.project.id ?? focusedProjectIdRef.current;
    focusedProjectIdRef.current = currentProjectId;
    focusSearchOnOverviewRef.current = focusSearch;
    updateMobileProjectShelfSession({ view: 'overview', focusedProjectId: currentProjectId });
    setView('overview');
  };

  const showPager = () => {
    overviewScrollTopRef.current = overviewRef.current?.scrollTop ?? overviewScrollTopRef.current;
    updateMobileProjectShelfSession({
      view: 'pager',
      focusedProjectId: focusedProjectIdRef.current,
      overviewScrollTop: overviewScrollTopRef.current,
    });
    setView('pager');
  };

  const openProject = (project: ProjectSummary) => {
    focusedProjectIdRef.current = project.id;
    overviewScrollTopRef.current = overviewRef.current?.scrollTop ?? overviewScrollTopRef.current;
    updateMobileProjectShelfSession({
      view,
      focusedProjectId: project.id,
      overviewScrollTop: overviewScrollTopRef.current,
    });
    onOpen(project);
  };

  const trackPagerScroll = () => {
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0) return;
    const nearest = Math.min(
      Math.max(0, Math.round(pager.scrollLeft / pager.clientWidth)),
      Math.max(0, allRows.length - 1),
    );
    focusedProjectIdRef.current = allRows[nearest]?.project.id ?? null;
    setPageIndex((previous) => (previous === nearest ? previous : nearest));
  };

  const accountCorner = (
    <>
      <UserAvatar
        forwardRef={avatarRef}
        initial={userInitial}
        size={40}
        fontSize={15}
        title={t(accountSettingsEnabled ? 'userMenu.accountMenu' : 'userMenu.localMenu')}
        onClick={() => onMenuOpenChange((open) => !open)}
        expanded={menuOpen}
      />
      <UserMenu
        triggerRef={avatarRef}
        open={menuOpen}
        onClose={() => onMenuOpenChange(false)}
        scope="shelf"
      />
    </>
  );

  if (view === 'pager') {
    return (
      <main className="m-shelf" data-view="pager">
        <header className="m-shelf-pager__corners">
          <button
            type="button"
            className="m-shelf__view-toggle"
            onClick={() => showOverview()}
            aria-label={t('projectPicker.allProjectsCn')}
            aria-pressed="false"
          >
            <LayoutGrid size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div className="m-shelf-pager__actions">
            <button
              type="button"
              className="m-shelf__corner-button"
              onClick={() => showOverview(true)}
              aria-label={isZh ? '搜索项目' : 'Search projects'}
            >
              <Search size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="m-shelf__corner-button"
              onClick={onSettings}
              aria-label={t('userMenu.settings')}
            >
              <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
            {accountCorner}
          </div>
        </header>

        {loading ? (
          <div className="m-shelf__empty">{t('projectPicker.loading')}</div>
        ) : total === 0 ? (
          <div className="m-shelf__empty">
            <p>{t('projectPicker.empty')}</p>
            <button type="button" onClick={onCreate}>{t('projectPicker.newProject')}</button>
          </div>
        ) : (
          <div className="m-shelf-pager" ref={pagerRef} onScroll={trackPagerScroll}>
            {allRows.map((row) => {
              const { project, meta, lastEditedRel } = row;
              return (
                <button
                  key={project.id}
                  type="button"
                  className="m-shelf-pager__page"
                  onClick={() => openProject(project)}
                >
                  <span className="m-shelf-pager__kicker">
                    {meta.genre || t('projectPicker.source.localDraft')}
                  </span>
                  <strong className="m-shelf-pager__title">{project.name}</strong>
                  <span className="m-shelf-pager__epigraph">
                    {project.summary || meta.subtitle || t('projectPicker.newBookSubtitle')}
                  </span>
                  <span className="m-shelf-pager__meta">
                    {project.stats.nodes} {t('common.chapters')} ·{' '}
                    {project.stats.wordsReady
                      ? `${project.stats.words.toLocaleString()} ${t('common.words')}`
                      : t('common.counting')}{' '}
                    · {lastEditedRel}
                  </span>
                  <span className="m-shelf-pager__continue">
                    <span>{isZh ? '继续写作' : 'Continue writing'}</span>
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <footer className="m-shelf-pager__foot">
          <div className="m-shelf-pager__dots" aria-hidden="true">
            {allRows.map((row, index) => (
              <span key={row.project.id} data-current={index === pageIndex ? 'true' : 'false'} />
            ))}
          </div>
          <button type="button" className="m-shelf-pager__create" onClick={onCreate}>
            <Plus size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t('projectPicker.newProject')}</span>
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main
      ref={overviewRef}
      className="m-shelf"
      data-view="overview"
      onScroll={(event) => {
        overviewScrollTopRef.current = event.currentTarget.scrollTop;
      }}
    >
      <header className="m-shelf__head">
        <div className="m-shelf__head-lead">
          <button
            type="button"
            className="m-shelf__view-toggle is-active"
            onClick={showPager}
            aria-label={isZh ? '切换到单本浏览' : 'Show one project at a time'}
            aria-pressed="true"
          >
            <LayoutGrid size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <h1>{t('projectPicker.header.titleEm')}</h1>
        </div>
        <div className="m-shelf__account">
          <button
            type="button"
            className="m-shelf__settings"
            onClick={onSettings}
            aria-label={t('userMenu.settings')}
          >
            <Settings size={19} aria-hidden="true" />
          </button>
          {accountCorner}
        </div>
      </header>

      <section className="m-shelf__controls" aria-label={t('projectPicker.allProjectsCn')}>
        <label className="m-shelf__search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={isZh ? '搜索项目' : 'Search projects'}
            aria-label={isZh ? '搜索项目' : 'Search projects'}
          />
        </label>
        <button type="button" className="m-shelf__create" onClick={onCreate}>
          <Plus size={18} aria-hidden="true" />
          <span>{t('projectPicker.newProject')}</span>
        </button>
      </section>

      <nav className="m-shelf__filters" aria-label={isZh ? '项目筛选' : 'Project filters'}>
        {(
          [
            ['all', t('projectPicker.filters.all'), counts.all],
            ['active', t('projectPicker.filters.active'), counts.active],
            ['paused', t('projectPicker.filters.paused'), counts.paused],
          ] as Array<[MobileProjectShelfFilter, string, number]>
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            className={filter === key ? 'is-active' : undefined}
            onClick={() => onFilterChange(key)}
            aria-pressed={filter === key}
          >
            <span>{label}</span>
            <small>{count}</small>
          </button>
        ))}
      </nav>

      {loading ? (
        <div className="m-shelf__empty">{t('projectPicker.loading')}</div>
      ) : total === 0 ? (
        <div className="m-shelf__empty">
          <p>{t('projectPicker.empty')}</p>
          <button type="button" onClick={onCreate}>{t('projectPicker.newProject')}</button>
        </div>
      ) : (
        <section className="m-shelf__list">
          {rows.map((row) => {
            const { project, meta, colorToken, glyph, lastEditedRel, wordProgress } = row;
            const actionsOpen = actionsProjectId === project.id;
            return (
              <article
                key={project.id}
                className="m-shelf-card"
                style={{ ['--m-shelf-color' as string]: `var(${colorToken})` }}
              >
                <button
                  type="button"
                  className="m-shelf-card__open"
                  onClick={() => openProject(project)}
                  aria-label={project.name}
                >
                  <span className="m-shelf-card__cover" aria-hidden="true">
                    <strong>{glyph}</strong>
                    <small>{meta.genre || t('projectPicker.source.localDraft')}</small>
                  </span>
                  <span className="m-shelf-card__body">
                    <span className="m-shelf-card__title">{project.name}</span>
                    <span className="m-shelf-card__summary">
                      {project.summary || meta.subtitle || t('projectPicker.newBookSubtitle')}
                    </span>
                    <span className="m-shelf-card__meta">
                      <span>
                        {project.stats.wordsReady
                          ? `${project.stats.words.toLocaleString()} ${t('common.words')}`
                          : t('common.counting')}
                      </span>
                      <span>
                        {project.stats.nodes} {t('common.chapters')}
                      </span>
                      <span>{lastEditedRel}</span>
                    </span>
                    {wordProgress !== null && (
                      <span
                        className="m-shelf-card__progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(wordProgress)}
                      >
                        <span style={{ width: `${wordProgress}%` }} />
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="m-shelf-card__more"
                  onClick={() => setActionsProjectId(actionsOpen ? null : project.id)}
                  aria-label={isZh ? `${project.name} 操作` : `${project.name} actions`}
                  aria-expanded={actionsOpen}
                >
                  <MoreHorizontal size={20} aria-hidden="true" />
                </button>
                {actionsOpen && (
                  <div className="m-shelf-card__actions">
                    <button type="button" onClick={() => onEdit(project)}>
                      <Pencil size={17} aria-hidden="true" />{t('common.edit')}
                    </button>
                    <button type="button" className="is-danger" onClick={() => onDelete(project)}>
                      <Trash2 size={17} aria-hidden="true" />{t('common.delete')}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      <footer className="m-shelf__foot">
        <span>
          {accountSettingsEnabled && user?.email
            ? user.email
            : t('projectPicker.footer.local')}
        </span>
        <span>{t('projectPicker.footer.brand')}</span>
      </footer>
    </main>
  );
}
