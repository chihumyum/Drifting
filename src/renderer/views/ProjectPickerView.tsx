import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProject, type ProjectSummary } from '../usecase/useProject';
import { useAuthStore } from '../store/auth';
import { SyncStatusHUD } from '../components/sync/SyncStatusHUD';
import { UserAvatar, UserMenu } from '../components/topBars/UserMenu';
import { FilterChip } from '../components/ui/FilterChip';
import { parseKv } from '../domain/kv';
import { getPlatformRuntime } from '../platform/runtime';
import { BookOpen, Grid2X2, List, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { DEFAULT_PROJECT_TARGET, useWritingStatsStore } from '../store/writing-stats-store';
import '../../styles/project-picker.css';
import loglevel from 'loglevel';
import { MobileProjectShelfContent } from '../shells/mobile/standalone/MobileProjectShelfContent';

function WindowDragStrip() {
  if (!getPlatformRuntime().desktopWindowControls) return null;
  return <div className="pp__window-drag-strip" data-tauri-drag-region aria-hidden />;
}

const log = loglevel.getLogger('ProjectPickerView');
log.setLevel(loglevel.levels.DEBUG);

type View = 'grid' | 'list';
type Filter = 'all' | 'active' | 'paused';
type Status = 'writing' | 'draft' | 'paused';

function activateOnEnterOrSpace(event: React.KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  action();
}

const STORY_TOKENS = [
  '--story-1',
  '--story-2',
  '--story-3',
  '--story-4',
  '--story-5',
  '--story-6',
] as const;

function hashToColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i) * (i + 7)) >>> 0;
  return STORY_TOKENS[h % STORY_TOKENS.length];
}

function glyphFor(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '◇';
  // Match first letter / CJK char with Unicode aware regex
  const m = trimmed.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : trimmed[0]).toUpperCase();
}

function isZh(locale: string): boolean {
  return locale.startsWith('zh');
}

function formatRelative(iso: string, locale: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const zh = isZh(locale);
  if (diff < min) return zh ? '刚刚' : 'just now';
  if (diff < hr) {
    const n = Math.floor(diff / min);
    return zh ? `${n} 分钟前` : `${n} min ago`;
  }
  if (diff < day) {
    const n = Math.floor(diff / hr);
    return zh ? `${n} 小时前` : `${n} hr ago`;
  }
  if (diff < 2 * day) return zh ? '昨天' : 'yesterday';
  if (diff < 30 * day) {
    const n = Math.floor(diff / day);
    return zh ? `${n} 天前` : `${n} days ago`;
  }
  if (diff < 365 * day) {
    const n = Math.floor(diff / (30 * day));
    return zh ? `${n} 月前` : `${n} mo ago`;
  }
  const n = Math.floor(diff / (365 * day));
  return zh ? `${n} 年前` : `${n} yr ago`;
}

function formatCreated(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y} · ${m} · ${day}`;
}

function statusFor(iso: string): Status {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'draft';
  const days = (Date.now() - then) / (24 * 3600 * 1000);
  if (days <= 7) return 'writing';
  if (days <= 30) return 'draft';
  return 'paused';
}

function formatWordsK(words: number): string {
  if (words < 1000) return String(words);
  return `${(words / 1000).toFixed(1)}k`;
}

interface ProjectFormState {
  name: string;
  summary: string;
}

interface ProjectDisplayMeta {
  subtitle?: string;
  genre?: string;
}

function displayMetaFor(kvJson: string): ProjectDisplayMeta {
  const kv = parseKv(kvJson);
  return {
    subtitle: kv.find((row) => row.key === '副标题')?.value.trim() || undefined,
    genre: kv.find((row) => row.key === '体裁')?.value.trim() || undefined,
  };
}

interface ProjectPickerViewProps {
  presentation?: 'desktop' | 'mobile';
}

export function ProjectPickerView({ presentation = 'desktop' }: ProjectPickerViewProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const writingPlans = useWritingStatsStore((s) => s.plans);
  const { loadProjectSummaries, createProject, updateProject, deleteProject } = useProject({
    userId: user?.id ?? '',
  });
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('grid');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchProjects = useCallback(async () => {
    const data = await loadProjectSummaries({ pullRemote: true });
    log.debug('Loaded project summaries:', data);
    setProjects(data);
  }, [loadProjectSummaries]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        await fetchProjects();
      } catch (e) {
        log.error('Failed to init projects view', e);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.id, fetchProjects]);

  const decorated = useMemo(
    () =>
      projects.map((p) => {
        const meta = displayMetaFor(p.kvJson);
        const status = statusFor(p.updatedAt);
        const wordTarget = writingPlans[p.id]?.projectWordTarget ?? DEFAULT_PROJECT_TARGET;
        return {
          project: p,
          meta,
          status,
          colorToken: hashToColor(p.id),
          glyph: glyphFor(p.name),
          lastEditedRel: formatRelative(p.updatedAt, i18n.language),
          createdRel: formatCreated(p.createdAt),
          wordProgress:
            wordTarget > 0 ? Math.min(100, Math.max(0, (p.stats.words / wordTarget) * 100)) : null,
        };
      }),
    [projects, i18n.language, writingPlans],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
  const filtered = decorated.filter(({ project, meta, status }) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'active' && (status === 'writing' || status === 'draft')) ||
      (filter === 'paused' && status === 'paused');
    const matchesQuery =
      !normalizedQuery ||
      [project.name, project.summary, meta.subtitle, meta.genre]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase(i18n.language).includes(normalizedQuery));
    return matchesFilter && matchesQuery;
  });

  const counts = useMemo(
    () => ({
      all: decorated.length,
      active: decorated.filter((d) => d.status === 'writing' || d.status === 'draft').length,
      paused: decorated.filter((d) => d.status === 'paused').length,
    }),
    [decorated],
  );

  const handleOpen = useCallback(
    (id: string) => {
      navigate(`/project/${id}`);
    },
    [navigate],
  );

  const handleCreate = useCallback(
    async (form: ProjectFormState) => {
      if (busy) return;
      setBusy(true);
      try {
        const name = form.name.trim() || t('projectPicker.untitledProject');
        const project = await createProject({ projectName: name });
        const summary = form.summary.trim();
        if (summary) {
          await updateProject(project.id, { name, summary });
        }
        setCreateOpen(false);
        navigate(`/project/${project.id}`);
      } catch (e) {
        log.error('Failed to create project:', e);
      } finally {
        setBusy(false);
      }
    },
    [busy, createProject, updateProject, navigate, t],
  );

  const handleEdit = useCallback(
    async (form: ProjectFormState) => {
      if (!editing || busy) return;
      setBusy(true);
      try {
        const name = form.name.trim() || editing.name;
        await updateProject(editing.id, { name, summary: form.summary.trim() });
        await fetchProjects();
        setEditing(null);
      } catch (e) {
        log.error('Failed to update project:', e);
      } finally {
        setBusy(false);
      }
    },
    [editing, busy, updateProject, fetchProjects],
  );

  const handleDelete = useCallback(async () => {
    if (!confirmDelete || busy) return;
    setBusy(true);
    try {
      const ok = await deleteProject(confirmDelete.id);
      if (ok) {
        setProjects((prev) => prev.filter((p) => p.id !== confirmDelete.id));
      }
      setConfirmDelete(null);
    } catch (e) {
      log.error('Failed to delete project:', e);
    } finally {
      setBusy(false);
    }
  }, [confirmDelete, busy, deleteProject]);

  const userInitial = (user?.name?.trim() || user?.email?.trim() || '·')[0].toUpperCase();

  if (presentation === 'mobile') {
    return (
      <div className="pp pp--mobile">
        <MobileProjectShelfContent
          loading={loading}
          rows={filtered}
          total={decorated.length}
          counts={counts}
          filter={filter}
          query={query}
          user={user}
          userInitial={userInitial}
          avatarRef={avatarRef}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onCreate={() => setCreateOpen(true)}
          onOpen={(project) => handleOpen(project.id)}
          onEdit={setEditing}
          onDelete={setConfirmDelete}
        />

        {confirmDelete && (
          <DeleteModal
            project={confirmDelete}
            busy={busy}
            onConfirm={handleDelete}
            onClose={() => (busy ? undefined : setConfirmDelete(null))}
          />
        )}
        {createOpen && (
          <ProjectFormModal
            mode="create"
            busy={busy}
            onSubmit={handleCreate}
            onClose={() => (busy ? undefined : setCreateOpen(false))}
          />
        )}
        {editing && (
          <ProjectFormModal
            mode="edit"
            project={editing}
            busy={busy}
            onSubmit={handleEdit}
            onClose={() => (busy ? undefined : setEditing(null))}
          />
        )}

        <SyncStatusHUD />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pp">
        <WindowDragStrip />
        <div className="pp__inner">
          <div className="pp-empty">{t('projectPicker.loading')}</div>
        </div>
        <SyncStatusHUD />
      </div>
    );
  }

  return (
    <div className="pp">
      <WindowDragStrip />
      <div className="pp__inner">
        {/* ─── Header ─── */}
        <header className="pp-head">
          <div>
            <div className="pp-head__kicker">
              <span>Drifting</span>
              <span className="pp-head__kicker-sep">/</span>
              <span>{t('projectPicker.header.workspace')}</span>
            </div>
            <h1 className="pp-head__title">{t('projectPicker.header.titleEm')}</h1>
            <p className="pp-head__sub">{t('projectPicker.header.subtitle')}</p>
          </div>
          <aside className="pp-head__aside">
            <div className="pp-head__user">
              <div className="pp-head__user-name">
                <div className="pp-head__user-name-main">
                  {user?.name || user?.email || 'Drifting'}
                </div>
                <div className="pp-head__user-name-plan">{t('projectPicker.header.userPlan')}</div>
              </div>
              <UserAvatar
                forwardRef={avatarRef}
                initial={userInitial}
                size={36}
                fontSize={16}
                title={t('userMenu.accountMenu')}
                onClick={() => setMenuOpen((v) => !v)}
                expanded={menuOpen}
              />
            </div>
            <UserMenu
              triggerRef={avatarRef}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              scope="shelf"
            />
          </aside>
        </header>

        {/* ─── Toolbar ─── */}
        <div className="pp-toolbar">
          <label className="pp-toolbar__search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isZh(i18n.language) ? '搜索项目' : 'Search projects'}
              aria-label={isZh(i18n.language) ? '搜索项目' : 'Search projects'}
            />
          </label>
          <div className="pp-toolbar__chips">
            {(
              [
                ['all', t('projectPicker.filters.all'), counts.all],
                ['active', t('projectPicker.filters.active'), counts.active],
                ['paused', t('projectPicker.filters.paused'), counts.paused],
              ] as Array<[Filter, string, number]>
            ).map(([k, label, n]) => (
              <FilterChip
                key={k}
                active={filter === k}
                count={`· ${n}`}
                onClick={() => setFilter(k)}
              >
                {label}
              </FilterChip>
            ))}
          </div>
          <div className="pp-toolbar__actions">
            <div className="pp-toolbar__view">
              <button
                type="button"
                className={`pp-toolbar__view-btn ${view === 'grid' ? 'pp-toolbar__view-btn--active' : ''}`}
                onClick={() => setView('grid')}
                aria-label={t('projectPicker.view.card')}
                aria-pressed={view === 'grid'}
              >
                <Grid2X2 size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`pp-toolbar__view-btn ${view === 'list' ? 'pp-toolbar__view-btn--active' : ''}`}
                onClick={() => setView('list')}
                aria-label={t('projectPicker.view.list')}
                aria-pressed={view === 'list'}
              >
                <List size={17} aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              className="pp-toolbar__btn pp-toolbar__btn--accent"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={17} aria-hidden="true" /> {t('projectPicker.newProject')}
            </button>
          </div>
        </div>

        {/* ─── All projects ─── */}
        <section className="pp-section">
          <div className="pp-section__head">
            <div className="pp-section__title">
              <BookOpen className="pp-section__title-mark" size={18} aria-hidden="true" />
              <span className="pp-section__title-cn">{t('projectPicker.allProjectsCn')}</span>
            </div>
            <span className="pp-section__count">
              {t('projectPicker.projectCount', {
                filtered: filtered.length,
                total: decorated.length,
              })}
            </span>
          </div>

          {decorated.length === 0 ? (
            <div className="pp-empty">{t('projectPicker.empty')}</div>
          ) : view === 'grid' ? (
            <div className="pp-grid">
              {filtered.map((row) => (
                <ProjectCard
                  key={row.project.id}
                  row={row}
                  onOpen={() => handleOpen(row.project.id)}
                  onEdit={() => setEditing(row.project)}
                  onDelete={() => setConfirmDelete(row.project)}
                />
              ))}
              <div
                className="pp-card pp-card--new"
                onClick={() => setCreateOpen(true)}
                onKeyDown={(event) => activateOnEnterOrSpace(event, () => setCreateOpen(true))}
                role="button"
                tabIndex={0}
              >
                <div className="pp-card--new__glyph">
                  <Plus size={24} aria-hidden="true" />
                </div>
                <div className="pp-card--new__label">{t('projectPicker.newBookInline')}</div>
                <div className="pp-card--new__sub">{t('projectPicker.newBookSubtitle')}</div>
              </div>
            </div>
          ) : (
            <div className="pp-list">
              {filtered.map((row) => (
                <ProjectListRow
                  key={row.project.id}
                  row={row}
                  onOpen={() => handleOpen(row.project.id)}
                  onEdit={() => setEditing(row.project)}
                  onDelete={() => setConfirmDelete(row.project)}
                />
              ))}
              <div
                className="pp-list__row"
                style={{ borderStyle: 'dashed', cursor: 'pointer', color: 'hsl(var(--ink-4))' }}
                onClick={() => setCreateOpen(true)}
                onKeyDown={(event) => activateOnEnterOrSpace(event, () => setCreateOpen(true))}
                role="button"
                tabIndex={0}
              >
                <span className="pp-list__glyph">
                  <Plus size={18} aria-hidden="true" />
                </span>
                <div className="pp-list__title">
                  <span className="pp-list__title-main" style={{ color: 'hsl(var(--ink-4))' }}>
                    {t('projectPicker.newBookInline')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>

        <footer className="pp-foot">
          <span>{t('projectPicker.footer.brand')}</span>
          <span>{user?.email || t('projectPicker.footer.local')}</span>
        </footer>
      </div>

      {confirmDelete && (
        <DeleteModal
          project={confirmDelete}
          busy={busy}
          onConfirm={handleDelete}
          onClose={() => (busy ? undefined : setConfirmDelete(null))}
        />
      )}
      {createOpen && (
        <ProjectFormModal
          mode="create"
          busy={busy}
          onSubmit={handleCreate}
          onClose={() => (busy ? undefined : setCreateOpen(false))}
        />
      )}
      {editing && (
        <ProjectFormModal
          mode="edit"
          project={editing}
          busy={busy}
          onSubmit={handleEdit}
          onClose={() => (busy ? undefined : setEditing(null))}
        />
      )}

      <SyncStatusHUD />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */

export interface DecoratedRow {
  project: ProjectSummary;
  meta: ProjectDisplayMeta;
  status: Status;
  colorToken: string;
  glyph: string;
  lastEditedRel: string;
  createdRel: string;
  wordProgress: number | null;
}

interface CardProps {
  row: DecoratedRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ProjectCard({ row, onOpen, onEdit, onDelete }: CardProps) {
  const { t } = useTranslation();
  const { project, meta, status, colorToken, glyph, lastEditedRel, wordProgress } = row;
  const stats = project.stats;
  const sourceLabel =
    project.source === 'server'
      ? t('projectPicker.source.cloud')
      : t('projectPicker.source.localDraft');
  const categoryLabel = meta.genre || sourceLabel;

  return (
    <article
      className="pp-card"
      style={{ ['--pp-c' as string]: `var(${colorToken})` }}
    >
      <div className="pp-card__cover" aria-hidden="true">
        <span className="pp-card__cover-glyph">{glyph}</span>
        <span className="pp-card__cover-label">{categoryLabel}</span>
      </div>
      <div className="pp-card__body">
        <div className="pp-card__head">
          <div>
            <h2 className="pp-card__title">{project.name}</h2>
            {meta.subtitle && <div className="pp-card__subtitle">{meta.subtitle}</div>}
          </div>
          <div className="pp-card__menu" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="pp-card__menu-btn"
              onClick={onEdit}
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="pp-card__menu-btn"
              onClick={onDelete}
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="pp-card__summary">
          {project.summary || meta.subtitle || t('projectPicker.newBookSubtitle')}
        </p>
        <div className="pp-card__meta">
          <span>
            <b>{formatWordsK(stats.words)}</b> {t('common.words')}
          </span>
          <span>
            <b>{stats.nodes}</b> {t('common.chapters')}
          </span>
          <span>
            <b>{stats.storylines}</b> {t('common.storylinesUnit')}
          </span>
          <span>
            <b>{stats.elements}</b> {t('common.elementsUnit')}
          </span>
        </div>
        {wordProgress !== null && (
          <div
            className="pp-card__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(wordProgress)}
          >
            <div className="pp-card__progress-fill" style={{ width: `${wordProgress}%` }} />
          </div>
        )}
        <div className="pp-card__foot">
          <span className={`pp-card__status pp-card__status--${status}`}>
            {t(`projectPicker.status.${status}`)}
          </span>
          <span>{lastEditedRel}</span>
        </div>
      </div>
      <button
        type="button"
        className="pp-card__hit"
        onClick={onOpen}
        aria-label={project.name}
      />
    </article>
  );
}

function ProjectListRow({ row, onOpen, onEdit, onDelete }: CardProps) {
  const { t } = useTranslation();
  const { project, meta, status, colorToken, glyph, lastEditedRel } = row;
  const stats = project.stats;
  const subline =
    meta.genre ||
    (project.source === 'server'
      ? t('projectPicker.source.cloud')
      : t('projectPicker.source.localDraft'));

  return (
    <div
      className="pp-list__row"
      style={{ ['--pp-c' as string]: `var(${colorToken})` }}
    >
      <span className="pp-list__glyph">{glyph}</span>
      <div className="pp-list__title">
        <span className="pp-list__title-main">
          <em>《</em>
          {project.name}
          <em>》</em>
        </span>
        <span className="pp-list__title-sub">{subline}</span>
      </div>
      <div className="pp-list__sub">{project.summary || meta.subtitle || '—'}</div>
      <div className="pp-list__cell">
        <span className="pp-list__cell-v">
          {(stats.words / 1000).toFixed(1)}
          <em>k</em>
        </span>
        <span className="pp-list__cell-k">{t('common.words')}</span>
      </div>
      <div className="pp-list__cell">
        <span className="pp-list__cell-v">
          {stats.nodes}
          <em>{t('common.chapters')}</em>
        </span>
        <span className="pp-list__cell-k">{t('projectPicker.nodesLabel')}</span>
      </div>
      <div className="pp-list__cell">
        <span
          className="pp-list__cell-v"
          style={{ fontStyle: 'italic', color: 'hsl(var(--ink-2))' }}
        >
          {lastEditedRel}
        </span>
        <span className="pp-list__cell-k">{t(`projectPicker.status.${status}`)}</span>
      </div>
      <div className="pp-list__menu" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="pp-list__menu-btn"
          onClick={onEdit}
          title={t('common.edit')}
          aria-label={t('common.edit')}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pp-list__menu-btn"
          onClick={onDelete}
          title={t('common.delete')}
          aria-label={t('common.delete')}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className="pp-list__hit"
        onClick={onOpen}
        aria-label={project.name}
      />
    </div>
  );
}

/* ─── Modals ─── */

interface DeleteModalProps {
  project: ProjectSummary;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteModal({ project, busy, onConfirm, onClose }: DeleteModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, onClose]);

  const stats = project.stats;
  return (
    <div className="pp-modal-backdrop" onClick={onClose}>
      <div
        className="pp-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('projectPicker.delete.titlePrefix')}
      >
        <div className="pp-modal__head">
          <div className="pp-modal__kicker">{t('projectPicker.delete.kicker')}</div>
          <h2 className="pp-modal__title">
            {t('projectPicker.delete.titlePrefix')} <em>《{project.name}》</em>？
          </h2>
        </div>
        <div className="pp-modal__body">
          <p className="pp-modal__sub">
            {t('projectPicker.delete.body', {
              words: stats.words.toLocaleString(),
              nodes: stats.nodes,
              elements: stats.elements,
            })}
          </p>
        </div>
        <div className="pp-modal__foot">
          <button
            type="button"
            className="pp-modal__btn"
            onClick={onClose}
            disabled={busy}
            autoFocus
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="pp-modal__btn pp-modal__btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? t('projectPicker.delete.deleting') : t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ProjectFormModalProps {
  mode: 'create' | 'edit';
  project?: ProjectSummary;
  busy: boolean;
  onSubmit: (form: ProjectFormState) => void;
  onClose: () => void;
}

function ProjectFormModal({ mode, project, busy, onSubmit, onClose }: ProjectFormModalProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProjectFormState>({
    name: project?.name ?? '',
    summary: project?.summary ?? '',
  });

  const set =
    <K extends keyof ProjectFormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) onSubmit(form);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, form, onClose, onSubmit]);

  const isEdit = mode === 'edit';
  const submitLabel = isEdit
    ? busy
      ? t('common.saving')
      : t('common.save')
    : busy
      ? t('common.creating')
      : t('projectPicker.form.createSubmit');

  return (
    <div className="pp-modal-backdrop" onClick={onClose}>
      <div
        className="pp-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 540 }}
        role="dialog"
        aria-modal="true"
        aria-label={
          isEdit ? t('projectPicker.form.editKicker') : t('projectPicker.form.createKicker')
        }
      >
        <div className="pp-modal__head">
          <div className="pp-modal__kicker">
            {isEdit ? t('projectPicker.form.editKicker') : t('projectPicker.form.createKicker')}
          </div>
          <h2 className="pp-modal__title">
            {isEdit ? (
              <>
                {t('projectPicker.form.editTitle')} <em>《{project?.name}》</em>
              </>
            ) : (
              <>
                {t('projectPicker.form.createTitle')}{' '}
                <em>{t('projectPicker.form.createTitleEm')}</em>
              </>
            )}
          </h2>
        </div>
        <div className="pp-modal__body">
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">{t('projectPicker.form.nameLabel')}</span>
            <input
              className="pp-modal__input"
              placeholder={t('projectPicker.form.namePlaceholder')}
              value={form.name}
              onChange={set('name')}
              autoFocus
            />
          </div>
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">{t('projectPicker.form.summaryLabel')}</span>
            <textarea
              className="pp-modal__textarea"
              placeholder={t('projectPicker.form.summaryPlaceholder')}
              value={form.summary}
              onChange={set('summary')}
            />
          </div>
        </div>
        <div className="pp-modal__foot">
          <button type="button" className="pp-modal__btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="pp-modal__btn pp-modal__btn--primary"
            onClick={() => onSubmit(form)}
            disabled={busy}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
