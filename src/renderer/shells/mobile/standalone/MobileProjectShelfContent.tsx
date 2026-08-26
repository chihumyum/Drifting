import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  ArrowLeft,
  ArrowRight,
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

type MobileShelfFilter = 'all' | 'active' | 'paused';

interface MobileProjectShelfContentProps {
  loading: boolean;
  rows: DecoratedRow[];
  total: number;
  counts: Record<MobileShelfFilter, number>;
  filter: MobileShelfFilter;
  query: string;
  user: User | null;
  userInitial: string;
  avatarRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onMenuOpenChange: Dispatch<SetStateAction<boolean>>;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: MobileShelfFilter) => void;
  onCreate: () => void;
  onSettings: () => void;
  onOpen: (project: ProjectSummary) => void;
  onEdit: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

/** The shelf's default face: one work per screen, swiped horizontally — the
 * author's book is the hero, chrome stays in the corners. The page dots (or
 * the search corner) open the management list, which keeps every capability:
 * search, filters, edit, delete. */
export function MobileProjectShelfContent({
  loading,
  rows,
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
  const [view, setView] = useState<'pager' | 'list'>('pager');
  const [actionsProjectId, setActionsProjectId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const isZh = i18n.language.startsWith('zh');
  const accountSettingsEnabled = hostedAccountSettingsEnabled();

  const trackPagerScroll = () => {
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0) return;
    const nearest = Math.round(pager.scrollLeft / pager.clientWidth);
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
            onClick={() => setView('list')}
            aria-label={isZh ? '搜索项目' : 'Search projects'}
          >
            <Search size={18} aria-hidden="true" />
          </button>
          <button type="button" onClick={onSettings} aria-label={t('userMenu.settings')}>
            <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
          {accountCorner}
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
            {rows.map((row) => {
              const { project, meta, lastEditedRel } = row;
              return (
                <button
                  key={project.id}
                  type="button"
                  className="m-shelf-pager__page"
                  onClick={() => onOpen(project)}
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
          <button
            type="button"
            className="m-shelf-pager__dots"
            onClick={() => setView('list')}
            aria-label={t('projectPicker.allProjectsCn')}
          >
            {rows.map((row, index) => (
              <span key={row.project.id} data-current={index === pageIndex ? 'true' : 'false'} />
            ))}
          </button>
          <button type="button" className="m-shelf-pager__create" onClick={onCreate}>
            <Plus size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t('projectPicker.newProject')}</span>
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main className="m-shelf" data-view="list">
      <header className="m-shelf__head">
        <div className="m-shelf__head-lead">
          <button
            type="button"
            className="m-shelf__back"
            onClick={() => setView('pager')}
            aria-label={t('navigation.back')}
          >
            <ArrowLeft size={20} aria-hidden="true" />
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
          ] as Array<[MobileShelfFilter, string, number]>
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
                  onClick={() => onOpen(project)}
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
