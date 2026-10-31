import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectTrashExpiresAt, useProject, type ProjectSummary } from '../usecase/useProject';
import type { Project } from '../domain/project';
import { useAuthStore } from '../store/auth';
import { hostedAccountSettingsEnabled } from '../features/settings/hosted-settings-policy';
import { UserMenu } from '../components/topBars/UserMenu';
import { AccountAvatar } from '../components/ui/AccountAvatar';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { LoadingStatus } from '../components/ui/LoadingStatus';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../components/ui/Modal';
import { SandCell } from '../components/ui/SandCell';
import { parseKv } from '../domain/kv';
import { getPlatformRuntime } from '../platform/runtime';
import { DEFAULT_PROJECT_TARGET, useWritingStatsStore } from '../store/writing-stats-store';
import '../../styles/project-picker.css';
import loglevel from 'loglevel';
import { MobileProjectShelfContent } from '../shells/mobile/standalone/MobileProjectShelfContent';
import {
  readMobileProjectShelfSession,
  updateMobileProjectShelfSession,
} from '../shells/mobile/standalone/mobile-project-shelf-session';
import { events } from '../lib/events';
import { canUseHostedService } from '../lib/config';
import { projectDeletionErrorKey } from '../lib/project-deletion-feedback';
import {
  coverSeed,
  peekSandCoverMasks,
  requestSandCoverMasks,
  sandCoverKey,
} from '../lib/sand-cover';
import { useProjectRoutePreload } from '../app/useProjectRoutePreload';
import { useBuiltInSampleStore } from '../services/sample-project/first-run';
import { BrushIcon } from '../components/ui/BrushIcon';
import { KindMark } from '../components/ui/KindMark';

function WindowDragStrip() {
  if (!getPlatformRuntime().desktopWindowControls) return null;
  return <div className="pp__window-drag-strip" data-tauri-drag-region aria-hidden />;
}

const log = loglevel.getLogger('ProjectPickerView');
log.setLevel(loglevel.levels.DEBUG);

// Expired trash is purged a little after the shelf opens, so sync can first
// pull a restore made on another device.
const EXPIRED_TRASH_PURGE_DELAY_MS = 2 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  if (!trimmed) return '';
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
  const account = useAuthStore((s) => s.hostedUser);
  const writingPlans = useWritingStatsStore((s) => s.plans);
  const {
    loadProjectSummaries,
    createProject,
    updateProject,
    trashProject,
    restoreProject,
    loadTrashedProjects,
    deleteProject,
    purgeExpiredTrashedProjects,
  } = useProject({
    userId: user?.id ?? '',
  });
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [initialMobileShelfSession] = useState(readMobileProjectShelfSession);
  const [menuOpen, setMenuOpen] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>(() =>
    presentation === 'mobile' ? initialMobileShelfSession.filter : 'all',
  );
  const [query, setQuery] = useState(() =>
    presentation === 'mobile' ? initialMobileShelfSession.query : '',
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const openDelete = (project: ProjectSummary) => { setDeleteError(null); setConfirmDelete(project); };
  const [busy, setBusy] = useState(false);
  const [trashed, setTrashed] = useState<Project[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);

  useProjectRoutePreload(!loading && Boolean(user?.id));

  const fetchProjects = useCallback(async () => {
    const [data, trash] = await Promise.all([loadProjectSummaries(), loadTrashedProjects()]);
    log.debug('Loaded project summaries:', data);
    setProjects(data);
    setTrashed(trash);
    setConfirmDelete(current => current && data.some(project => project.id === current.id) ? current : null);
  }, [loadProjectSummaries, loadTrashedProjects]);

  useEffect(() => {
    if (!user?.id) return undefined;
    const timer = setTimeout(() => {
      void purgeExpiredTrashedProjects()
        .then((purged) => (purged.length > 0 ? fetchProjects() : undefined))
        .catch((error) => log.warn('Expired project purge failed:', error));
    }, EXPIRED_TRASH_PURGE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [user?.id, purgeExpiredTrashedProjects, fetchProjects]);

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

  // The built-in sample is written in the background on a new library's first
  // launch; show it as soon as it is complete.
  const samplePhase = useBuiltInSampleStore((state) => state.phase);
  const preparingSample = samplePhase === 'creating';
  const observedSamplePhase = useRef(samplePhase);
  useEffect(() => {
    const previous = observedSamplePhase.current;
    observedSamplePhase.current = samplePhase;
    if (!user?.id || samplePhase !== 'settled' || previous === 'settled') return;
    void fetchProjects().catch((error) => log.warn('Project refresh after the sample failed:', error));
  }, [samplePhase, fetchProjects, user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void fetchProjects().catch((error) => {
          log.warn('Remote project summary refresh failed:', error);
        });
      }, 50);
    };
    events.on('sync:project-changed', refresh);
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      events.off('sync:project-changed', refresh);
    };
  }, [fetchProjects, user?.id]);

  useEffect(() => {
    if (presentation !== 'mobile') return;
    updateMobileProjectShelfSession({ filter, query });
  }, [filter, presentation, query]);

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
            p.stats.wordsReady && wordTarget > 0
              ? Math.min(100, Math.max(0, (p.stats.words / wordTarget) * 100)) : null,
          wordTarget,
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
      navigate(`/project/${id}`, {
        state: presentation === 'desktop' ? { projectEntry: 'resume-last-content' } : null,
      });
    },
    [navigate, presentation],
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
    setDeleteError(null);
    try {
      const ok = await trashProject(confirmDelete.id);
      if (!ok) throw new Error('Project trash did not commit');
      setProjects((prev) => prev.filter((p) => p.id !== confirmDelete.id));
      setConfirmDelete(null);
      setTrashed(await loadTrashedProjects());
    } catch (e) {
      log.error('Failed to move project to the trash:', e);
      setDeleteError('projectPicker.trash.failed');
    } finally {
      setBusy(false);
    }
  }, [confirmDelete, busy, trashProject, loadTrashedProjects]);

  const handleRestore = useCallback(
    async (id: string) => {
      if (!(await restoreProject(id))) throw new Error('Project restore did not commit');
      await fetchProjects();
    },
    [restoreProject, fetchProjects],
  );

  const handleDeleteNow = useCallback(
    async (id: string) => {
      if (!(await deleteProject(id))) throw new Error('Project deletion did not commit');
      setTrashed((prev) => prev.filter((p) => p.id !== id));
    },
    [deleteProject],
  );

  const userInitial = (account?.name?.trim() || account?.email?.trim() || '·')[0].toUpperCase();

  if (presentation === 'mobile') {
    return (
      <div className="pp pp--mobile">
        <MobileProjectShelfContent
          loading={loading}
          rows={filtered}
          allRows={decorated}
          total={decorated.length}
          counts={counts}
          filter={filter}
          query={query}
          user={account}
          userInitial={userInitial}
          avatarRef={avatarRef}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onCreate={() => {
            if (!preparingSample) setCreateOpen(true);
          }}
          onSettings={() => navigate('/settings')}
          onOpen={(project) => handleOpen(project.id)}
          onEdit={setEditing}
          onDelete={openDelete}
        />

        {confirmDelete && (
          <DeleteModal
            project={confirmDelete}
            error={deleteError}
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

      </div>
    );
  }

  if (loading) {
    return (
      <div className="pp">
        <WindowDragStrip />
        <div className="pp__inner">
          <div className="pp-empty"><LoadingStatus label={t('projectPicker.loading')} /></div>
        </div>
      </div>
    );
  }

  // Project views share the stores the sample is written through.
  const openCreate = () => {
    if (!preparingSample) setCreateOpen(true);
  };

  return (
    <div className="pp">
      <WindowDragStrip />
      <div className="pp__inner">
        {/* ─── Header: the shelf's name and the account ─── */}
        <header className="pp-head">
          <h1 className="pp-head__title">{t('projectPicker.header.titleEm')}</h1>
          <GhostIconButton
            ref={avatarRef}
            glass="round"
            className="pp-head__account"
            icon={
              <span className="pp-head__avatar">
                <AccountAvatar image={account?.image} initial={userInitial} />
              </span>
            }
            title={t(
              hostedAccountSettingsEnabled() ? 'userMenu.accountMenu' : 'userMenu.localMenu',
            )}
            aria-label={t(
              hostedAccountSettingsEnabled() ? 'userMenu.accountMenu' : 'userMenu.localMenu',
            )}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          />
          <UserMenu
            triggerRef={avatarRef}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            scope="shelf"
            trashCount={trashed.length}
            onOpenTrash={() => setTrashOpen(true)}
          />
        </header>

        {/* ─── The books, and a slip to start the next one ─── */}
        <div className="pp-grid">
          {decorated.map((row) => (
            <ProjectCard
              key={row.project.id}
              row={row}
              onOpen={() => handleOpen(row.project.id)}
              onEdit={() => setEditing(row.project)}
              onDelete={() => openDelete(row.project)}
            />
          ))}
          {preparingSample && (
            <div className="pp-card pp-card--preparing" aria-busy="true">
              <LoadingStatus label={t('projectPicker.desk.preparingSample')} />
            </div>
          )}
          <SandCell
            selected={false}
            className="pp-card pp-card--new"
            onClick={openCreate}
            onKeyDown={(event) => activateOnEnterOrSpace(event, openCreate)}
            role="button"
            tabIndex={0}
            aria-disabled={preparingSample || undefined}
          >
            <BrushIcon name="plus" size={22} />
            <span>{t('projectPicker.desk.newCard')}</span>
            <small>{t('projectPicker.desk.newCardSub')}</small>
          </SandCell>
        </div>
      </div>

      {confirmDelete && (
        <TrashDialog
          project={confirmDelete}
          error={deleteError}
          busy={busy}
          onConfirm={handleDelete}
          onClose={() => (busy ? undefined : setConfirmDelete(null))}
        />
      )}
      {trashOpen && (
        <RecentlyDeletedDialog
          projects={trashed}
          onRestore={handleRestore}
          onDeleteNow={handleDeleteNow}
          onClose={() => setTrashOpen(false)}
        />
      )}
      {createOpen && (
        <ProjectFormDialog
          mode="create"
          busy={busy}
          onSubmit={handleCreate}
          onClose={() => (busy ? undefined : setCreateOpen(false))}
        />
      )}
      {editing && (
        <ProjectFormDialog
          mode="edit"
          project={editing}
          busy={busy}
          onSubmit={handleEdit}
          onClose={() => (busy ? undefined : setEditing(null))}
        />
      )}

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
  wordTarget: number;
}

/** Words as the shelf reads them: 8.6 万 in Chinese, 86.4k otherwise. */
function formatWords(words: number, locale: string): string {
  if (!isZh(locale)) return formatWordsK(words);
  if (words < 10_000) return String(words);
  return `${(words / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
}

/**
 * The cover's sand (lib/sand-cover.ts), drawn off the main path the first time
 * a book is shown and kept for the session. Until it lands the cover is a
 * plain slip of paper with its first letter.
 */
function useCoverMasks(project: ProjectSummary): string[] | null {
  const lines = project.cover.storylines;
  const chapters = project.stats.chapters;
  const key = sandCoverKey(project.id, chapters, lines);
  const [drawn, setDrawn] = useState<{ key: string; masks: string[] } | null>(null);
  const cached = peekSandCoverMasks(key);
  useEffect(() => {
    if (peekSandCoverMasks(key)) return undefined;
    return requestSandCoverMasks(
      key,
      { seed: coverSeed(project.id), chapters, storylines: lines },
      (masks) => setDrawn({ key, masks }),
    );
  }, [key, project.id, chapters, lines]);
  return cached ?? (drawn?.key === key ? drawn.masks : null);
}

function BookCover({ row }: { row: DecoratedRow }) {
  const { project, meta, glyph } = row;
  const masks = useCoverMasks(project);
  const lines = project.cover.storylines;
  return (
    <div className="pp-cover" aria-hidden="true">
      {masks?.map((mask, index) => (
        <i
          key={index}
          className="sand pp-cover__band"
          style={
            {
              '--sand-mask': `url(${mask})`,
              '--sand-c': lines[index]?.color || undefined,
            } as CSSProperties
          }
        />
      ))}
      <span className="pp-cover__glyph">{glyph || <KindMark kind="all" />}</span>
      {meta.genre && <span className="pp-cover__label">{meta.genre}</span>}
    </div>
  );
}

interface CardProps {
  row: DecoratedRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RowActions({ onEdit, onDelete }: Pick<CardProps, 'onEdit' | 'onDelete'>) {
  const { t } = useTranslation();
  return (
    <div className="pp-acts" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="pp-act"
        onClick={onEdit}
        title={t('common.edit')}
        aria-label={t('common.edit')}
      >
        <BrushIcon name="edit" size={15} />
      </button>
      <button
        type="button"
        className="pp-act pp-act--danger"
        onClick={onDelete}
        title={t('projectPicker.desk.moveToTrash')}
        aria-label={t('projectPicker.desk.moveToTrash')}
      >
        <BrushIcon name="trash" size={15} />
      </button>
    </div>
  );
}

function ProjectCard({ row, onOpen, onEdit, onDelete }: CardProps) {
  const { t, i18n } = useTranslation();
  const { project, meta, status, lastEditedRel, wordProgress, wordTarget } = row;
  const stats = project.stats;
  const title = project.name.trim() || t('projectPicker.desk.untitled');

  return (
    <article className="pp-card glass glass--rest">
      <BookCover row={row} />
      <div className="pp-card__body">
        <div className="pp-card__head">
          <div className="pp-card__titles">
            <h3 className="pp-card__title">{title}</h3>
            {meta.subtitle && <div className="pp-card__subtitle">{meta.subtitle}</div>}
          </div>
          <RowActions onEdit={onEdit} onDelete={onDelete} />
        </div>
        {project.summary && <p className="pp-card__summary">{project.summary}</p>}
        <div className="pp-card__meta">
          <span>
            <b>{stats.wordsReady ? formatWords(stats.words, i18n.language) : t('common.counting')}</b>
            {stats.wordsReady && t('projectPicker.desk.wordsUnit')}
          </span>
          <span>
            <b>{stats.chapters}</b>
            {t('projectPicker.desk.chaptersUnit', { count: stats.chapters })}
          </span>
          <span>
            <b>{stats.storylines}</b>
            {t('projectPicker.desk.storylinesUnit', { count: stats.storylines })}
          </span>
          <span>
            <b>{stats.elements}</b>
            {t('projectPicker.desk.elementsUnit', { count: stats.elements })}
          </span>
        </div>
        {wordProgress !== null && (
          <div className="pp-card__progress">
            <div className="pp-card__progress-k">
              <span>{t('projectPicker.desk.progress')}</span>
              <span>
                {t('projectPicker.desk.goal', {
                  pct: Math.round(wordProgress),
                  target: formatWords(wordTarget, i18n.language),
                })}
              </span>
            </div>
            <div
              className="sand-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(wordProgress)}
            >
              <span className="sand-stroke" style={{ width: `${wordProgress}%` }} />
            </div>
          </div>
        )}
        <div className={`pp-card__foot${wordProgress === null ? ' pp-card__foot--end' : ''}`}>
          <span className={`pp-status pp-status--${status}`}>
            {t(`projectPicker.status.${status}`)}
          </span>
          <span>{lastEditedRel}</span>
        </div>
      </div>
      <button
        type="button"
        className="pp-hit"
        onClick={onOpen}
        aria-label={t('projectPicker.desk.open', { name: title })}
      />
    </article>
  );
}

/* ─── Desktop dialogs: the shared shell (ModalRoot/ModalCard) and controls ─── */

interface TrashDialogProps {
  project: ProjectSummary;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Moving a book to Recently Deleted; it can come back for 30 days, but the
 * button still says danger, and the dialog opens on Cancel. */
function TrashDialog({ project, error, busy, onConfirm, onClose }: TrashDialogProps) {
  const { t } = useTranslation();
  const stats = project.stats;
  const title = t('projectPicker.desk.trashTitle', { name: project.name });
  return (
    <ModalRoot onClose={onClose} ariaLabel={title}>
      <ModalCard className="pp-dialog" width={420}>
        <ModalHeader title={title} />
        <ModalBody>
          <p>
            {t('projectPicker.trash.body', {
              words: stats.wordsReady ? stats.words.toLocaleString() : t('common.counting'),
              nodes: stats.chapters,
              elements: stats.elements,
            })}
          </p>
          <p className="pp-dialog__lead">{t(canUseHostedService()
            ? 'projectPicker.trash.remoteNote' : 'projectPicker.trash.localNote')}</p>
          {error && (
            <p role="alert" className="pp-dialog__error">
              <BrushIcon name="status-warning" size={13} />
              {t(error)}
            </p>
          )}
        </ModalBody>
        <ModalActions>
          <Button onClick={onClose} disabled={busy} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            <BrushIcon name={busy ? 'loader' : 'trash'} size={14} className={busy ? 'ui-spin' : undefined} />
            {busy ? t('projectPicker.trash.moving') : t('projectPicker.trash.confirm')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}

interface RecentlyDeletedDialogProps {
  projects: Project[];
  onRestore: (id: string) => Promise<void>;
  onDeleteNow: (id: string) => Promise<void>;
  onClose: () => void;
}

function RecentlyDeletedDialog({ projects, onRestore, onDeleteNow, onClose }: RecentlyDeletedDialogProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const busy = busyId !== null;

  const run = async (id: string, action: () => Promise<void>, errorKey: (e: unknown) => string) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      setConfirming(null);
    } catch (e) {
      log.error('Recently deleted project action failed:', e);
      setError(errorKey(e));
    } finally {
      setBusyId(null);
    }
  };

  const expiryLabel = (deletedAt: string) => {
    const days = Math.ceil((projectTrashExpiresAt(deletedAt).getTime() - openedAt) / DAY_MS);
    return days > 0
      ? t('projectPicker.trash.expiresIn', { count: days })
      : t('projectPicker.trash.expiresSoon');
  };

  // Escape and the mist step back from the confirmation before they close.
  const dismiss = () => {
    if (busy) return;
    if (confirming) setConfirming(null);
    else onClose();
  };

  const errorLine = error && (
    <p role="alert" className="pp-dialog__error">
      <BrushIcon name="status-warning" size={13} />
      {t(error)}
    </p>
  );

  return (
    <ModalRoot onClose={dismiss} ariaLabel={t('projectPicker.desk.trashList.title')}>
      <ModalCard className="pp-dialog" width={420}>
        {confirming ? (
          <>
            <ModalHeader
              kicker={t('projectPicker.desk.trashList.title')}
              title={t('projectPicker.desk.trashList.confirmTitle', { name: confirming.name })}
            />
            <ModalBody>
              <p>{t('projectPicker.trash.permanentBody')}</p>
              <p className="pp-dialog__lead">{t(canUseHostedService()
                ? 'projectPicker.delete.remoteBody' : 'projectPicker.delete.localBody')}</p>
              {errorLine}
            </ModalBody>
            <ModalActions>
              <Button onClick={() => setConfirming(null)} disabled={busy} autoFocus>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void run(confirming.id, () => onDeleteNow(confirming.id),
                  projectDeletionErrorKey)}
                disabled={busy}
              >
                <BrushIcon name={busy ? 'loader' : 'trash'} size={14} className={busy ? 'ui-spin' : undefined} />
                {busy ? t('projectPicker.delete.deleting') : t(canUseHostedService()
                  ? 'projectPicker.delete.everywhere' : 'common.delete')}
              </Button>
            </ModalActions>
          </>
        ) : (
          <>
            <ModalHeader
              title={t('projectPicker.desk.trashList.title')}
              onClose={busy ? undefined : onClose}
              closeLabel={t('common.close')}
            />
            <ModalBody>
              <p className="pp-dialog__lead">{t(canUseHostedService()
                ? 'projectPicker.desk.trashList.sub' : 'projectPicker.desk.trashList.subLocal')}</p>
              {projects.length === 0 ? (
                <EmptyState density="compact" message={t('projectPicker.desk.trashList.empty')} />
              ) : (
                <div className="pp-trash">
                  {projects.map((project) => (
                    <SandCell key={project.id} selected={false} className="pp-trash__row">
                      <div className="pp-trash__text">
                        <span className="pp-trash__name">{project.name}</span>
                        <span className="pp-trash__meta">
                          {project.deletedAt ? expiryLabel(project.deletedAt) : null}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(project.id, () => onRestore(project.id),
                          () => 'projectPicker.trash.restoreFailed')}
                      >
                        {busyId === project.id ? t('projectPicker.trash.restoring') : t('projectPicker.trash.restore')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => { setError(null); setConfirming(project); }}
                      >
                        {t('projectPicker.trash.deleteNow')}
                      </Button>
                    </SandCell>
                  ))}
                </div>
              )}
              {errorLine}
            </ModalBody>
            <ModalActions>
              <Button onClick={onClose} disabled={busy} autoFocus>
                {t('common.close')}
              </Button>
            </ModalActions>
          </>
        )}
      </ModalCard>
    </ModalRoot>
  );
}

interface ProjectFormProps {
  mode: 'create' | 'edit';
  project?: ProjectSummary;
  busy: boolean;
  onSubmit: (form: ProjectFormState) => void;
  onClose: () => void;
}

function ProjectFormDialog({ mode, project, busy, onSubmit, onClose }: ProjectFormProps) {
  const { t } = useTranslation();
  const nameId = useId();
  const summaryId = useId();
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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) onSubmit(form);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, form, onSubmit]);

  const isEdit = mode === 'edit';
  const title = isEdit
    ? t('projectPicker.desk.form.editTitle', { name: project?.name ?? '' })
    : t('projectPicker.desk.form.createTitle');
  const submitLabel = isEdit
    ? busy
      ? t('common.saving')
      : t('common.save')
    : busy
      ? t('common.creating')
      : t('projectPicker.form.createSubmit');

  return (
    <ModalRoot onClose={onClose} ariaLabel={title}>
      <ModalCard className="pp-dialog" width={420}>
        <ModalHeader title={title} onClose={onClose} closeLabel={t('common.close')} />
        <ModalBody>
          <div className="dialog-section">
            <label className="dialog-section__label" htmlFor={nameId}>
              {t('projectPicker.desk.form.nameLabel')}
            </label>
            <label className="ui-field glass glass--rest glass--field">
              <input
                id={nameId}
                placeholder={t('projectPicker.form.namePlaceholder')}
                value={form.name}
                onChange={set('name')}
                disabled={busy}
                autoFocus
              />
            </label>
          </div>
          <div className="dialog-section">
            <label className="dialog-section__label" htmlFor={summaryId}>
              {t('projectPicker.desk.form.summaryLabel')}
            </label>
            <label className="ui-field ui-field--area glass glass--rest glass--field">
              <textarea
                id={summaryId}
                placeholder={t('projectPicker.form.summaryPlaceholder')}
                value={form.summary}
                onChange={set('summary')}
                disabled={busy}
              />
            </label>
          </div>
        </ModalBody>
        <ModalActions>
          <kbd className="pp-dialog__kbd">{submitShortcut()}</kbd>
          <span className="pp-dialog__grow" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => onSubmit(form)} disabled={busy}>
            {submitLabel}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}

function submitShortcut(): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return mac ? '⌘↵' : 'Ctrl+↵';
}

/* ─── The paused mobile shelf's modals ─── */

interface DeleteModalProps {
  project: ProjectSummary;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteModal({ project, error, busy, onConfirm, onClose }: DeleteModalProps) {
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
        aria-label={t('projectPicker.trash.titlePrefix')}
      >
        <div className="pp-modal__head">
          <div className="pp-modal__kicker">{t('projectPicker.trash.kicker')}</div>
          <h2 className="pp-modal__title">
            {t('projectPicker.trash.titlePrefix')} <em>《{project.name}》</em>？
          </h2>
        </div>
        <div className="pp-modal__body">
          <p className="pp-modal__sub">
            {t('projectPicker.trash.body', {
              words: stats.wordsReady ? stats.words.toLocaleString() : t('common.counting'),
              nodes: stats.chapters,
              elements: stats.elements,
            })}
          </p>
          <p className="pp-modal__sub">{t(canUseHostedService()
            ? 'projectPicker.trash.remoteNote' : 'projectPicker.trash.localNote')}</p>
          {error && <p role="alert" className="pp-modal__sub">{t(error)}</p>}
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
            className="pp-modal__btn pp-modal__btn--primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? t('projectPicker.trash.moving') : t('projectPicker.trash.confirm')}
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
