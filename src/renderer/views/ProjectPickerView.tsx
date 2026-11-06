import { formatRelativeTime as formatRelative } from '../../shared/locale-format';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectTrashExpiresAt, useProject, type ProjectSummary } from '../usecase/useProject';
import type { Project } from '../domain/project';
import { useAuthStore } from '../store/auth';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { LoadingStatus } from '../components/ui/LoadingStatus';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../components/ui/Modal';
import { SandCell } from '../components/ui/SandCell';
import { parseKv } from '../domain/kv';
import { getPlatformRuntime } from '../platform/runtime';
import { DEFAULT_PROJECT_TARGET, useWritingStatsStore } from '../store/writing-stats-store';
import { ShelfRail } from './shelf/ShelfRail';
import { SandStrip } from './shelf/SandStrip';
import { WritingHeatmap, type HeatmapBook } from './shelf/WritingHeatmap';
import { formatShelfWords } from './shelf/shelf-format';
import { useShelfWritingYear } from './shelf/useShelfWritingYear';
import '../../styles/project-picker.css';
import loglevel from 'loglevel';
import { events } from '../lib/events';
import { canUseHostedService } from '../lib/config';
import { projectDeletionErrorKey } from '../lib/project-deletion-feedback';
import { coverSeed } from '../lib/sand-cover';
import { peekShelfCover, requestShelfCover, shelfCoverKey, type ShelfCover } from '../lib/shelf-cover/covers';
import { readCoverStyle, subscribeCoverStyle, turnCoverStyle } from '../lib/shelf-cover/preference';
import type { CoverStyleId } from '../lib/shelf-cover/styles';
import { useProjectRoutePreload } from '../app/useProjectRoutePreload';
import { useBuiltInSampleStore } from '../services/built-in-sample/first-run';
import { exportBookToFile, importBookFromFile } from '../services/book-transfer/book-transfer.service';
import { BookImportError } from '../services/book-transfer/import-book';
import { HostedQuotaExceededError } from '../sync/hosted/quota';
import { BrushIcon } from '../components/ui/BrushIcon';
import { useCharSeaEnabled, useCharSeaHold, useCharSeaShape } from '../components/char-sea/useCharSea';
import { markSampleLanded, noteBookOpened, useFirstRunArrival, useSampleOnShelf } from '../components/first-run/first-run-shelf';
import { charSeaRegistry } from '../lib/char-sea/char-sea-registry';
import { SAMPLE_LANDING_DELAY_MS } from '../lib/motion';
import { HostedRestoreBanner } from '../features/sync-status/HostedRestoreProgress';
import { platformShortcut } from '../lib/shortcuts';

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
// The sample's landing ring: a little lighter than the press that opens a book (1.3).
const SAMPLE_LANDING_DROP = 1.1;

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

export function ProjectPickerView() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // The shelf lies on the sea of characters: its own ground is left clear,
  // and the slip for a new book is glass only the water shows.
  const onSea = useCharSeaEnabled();
  useCharSeaHold('surface', onSea);
  const { attach: newSlipRef } = useCharSeaShape<HTMLDivElement>({ rest: 0, radius: 2, hover: false });
  const shelfClass = onSea ? 'pp pp--sea' : 'pp';
  const user = useAuthStore((s) => s.user);
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
  const coverStyle = useCoverStyle();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const openDelete = (project: ProjectSummary) => { setDeleteError(null); setConfirmDelete(project); };
  const [busy, setBusy] = useState(false);
  const [trashed, setTrashed] = useState<Project[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [transferError, setTransferError] = useState<TransferError | null>(null);
  // The book under the pointer: the heatmap shows it alone.
  const [focusId, setFocusId] = useState<string | null>(null);

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

  const handleOpen = useCallback(
    (id: string) => {
      noteBookOpened(id);
      navigate(`/project/${id}`, {
        state: { projectEntry: 'resume-last-content' },
      });
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

  const handleExport = useCallback(async (project: ProjectSummary) => {
    if (exportingId) return;
    setExportingId(project.id);
    try {
      await exportBookToFile(project.id);
    } catch (error) {
      log.error('Failed to export the book:', error);
      setTransferError({ title: 'projectPicker.bookTransfer.exportFailedTitle', message: t('projectPicker.bookTransfer.exportFailed') });
    } finally {
      setExportingId(null);
    }
  }, [exportingId, t]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    try {
      if (await importBookFromFile(() => setImporting(true))) await fetchProjects();
    } catch (error) {
      log.error('Failed to import the book:', error);
      setTransferError({ title: 'projectPicker.bookTransfer.importFailedTitle', message: importErrorMessage(error, t) });
    } finally {
      setImporting(false);
    }
  }, [importing, fetchProjects, t]);

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

  const year = useShelfWritingYear(!loading && Boolean(user?.id), projects);
  const heatBooks = useMemo<HeatmapBook[]>(
    () => decorated.map((row) => ({
      id: row.project.id,
      name: row.project.name.trim() || t('projectPicker.desk.untitled'),
      color: `hsl(var(${row.colorToken}))`,
    })),
    [decorated, t],
  );
  const libraryWords = decorated.every((row) => row.project.stats.wordsReady)
    ? decorated.reduce((sum, row) => sum + row.project.stats.words, 0)
    : null;

  if (loading) {
    return (
      <div className={shelfClass}>
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
    <div className={shelfClass}>
      <WindowDragStrip />
      <div className="pp__frame">
        {/* ─── The rail: the shelf's name, import, Recently Deleted and the account ─── */}
        <ShelfRail
          books={decorated.length}
          words={libraryWords}
          trashCount={trashed.length}
          importing={importing}
          onImport={() => void handleImport()}
          onOpenTrash={() => setTrashOpen(true)}
        />
        <div className="pp__inner">
          <HostedRestoreBanner />

          {/* ─── A year of writing days, every book together ─── */}
          {year && <WritingHeatmap year={year} books={heatBooks} focusId={focusId} />}

          {/* ─── The books, and a slip to start the next one ─── */}
          <div className="pp-grid">
            {decorated.map((row) => (
              <ProjectCard
                key={row.project.id}
                row={row}
                onOpen={() => handleOpen(row.project.id)}
                onEdit={() => setEditing(row.project)}
                onExport={() => void handleExport(row.project)}
                exporting={exportingId === row.project.id}
                onDelete={() => openDelete(row.project)}
                recent={year ? (year.byProject[row.project.id] ?? year.days.map(() => 0)).slice(-30) : null}
                onPointAt={(pointed) => setFocusId((current) => (pointed ? row.project.id : current === row.project.id ? null : current))}
              />
            ))}
            {preparingSample && (
              <div className="pp-card pp-card--preparing" aria-busy="true">
                <LoadingStatus label={t('projectPicker.desk.preparingSample')} />
              </div>
            )}
            {importing && (
              <div className="pp-card pp-card--preparing" aria-busy="true">
                <LoadingStatus label={t('projectPicker.desk.importing')} />
              </div>
            )}
            <SandCell
              ref={newSlipRef}
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

          {/* ─── At the foot: turns every cover to the next style ─── */}
          <div className="pp-cover-style">
            <GhostIconButton
              glass="round"
              className="pp-cover-style__turn"
              icon={<BrushIcon name="rotate" size={16} />}
              title={t('projectPicker.desk.coverStyle.turn', {
                name: t(`projectPicker.desk.coverStyle.names.${coverStyle}`),
              })}
              aria-label={t('projectPicker.desk.coverStyle.turn', {
                name: t(`projectPicker.desk.coverStyle.names.${coverStyle}`),
              })}
              onClick={() => turnCoverStyle()}
            />
          </div>
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
      {transferError && (
        <TransferErrorDialog error={transferError} onClose={() => setTransferError(null)} />
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

/** The shelf's cover style (lib/shelf-cover/preference.ts), kept on this device. */
function useCoverStyle(): CoverStyleId {
  return useSyncExternalStore(subscribeCoverStyle, readCoverStyle, readCoverStyle);
}

/**
 * The cover in the shelf's style (lib/shelf-cover), drawn off the main path
 * the first time a book is shown in that style and kept for the session.
 * Until it lands the cover keeps what it showed, or is a plain slip of paper.
 */
function useShelfCover(project: ProjectSummary, glyph: string, style: CoverStyleId): ShelfCover | null {
  const request = useMemo(
    () => ({
      chapters: project.stats.chapters,
      storylines: project.cover.storylines,
      words: project.cover.words,
      latin: /[A-Za-z]/.test(glyph),
    }),
    [project.stats.chapters, project.cover, glyph],
  );
  const key = shelfCoverKey(project.id, style, request);
  const [shown, setShown] = useState<ShelfCover | null>(null);
  const cached = peekShelfCover(key);
  useEffect(() => {
    if (peekShelfCover(key)) return undefined;
    return requestShelfCover(key, style, { seed: coverSeed(project.id), ...request }, setShown);
  }, [key, style, project.id, request]);
  return cached ?? shown;
}

function BookCover({ row }: { row: DecoratedRow }) {
  const { project, meta, glyph } = row;
  const cover = useShelfCover(project, glyph, useCoverStyle());
  const lines = project.cover.storylines;
  return (
    <div
      className={`pp-cover${cover && cover.style !== 'sand' ? ' pp-cover--art' : ''}${cover?.dark ? ' pp-cover--dark' : ''}`}
      aria-hidden="true"
    >
      {cover?.style === 'sand'
        ? cover.urls.map((mask, index) => (
            <i
              key={mask}
              className="sand pp-cover__band"
              style={
                {
                  '--sand-mask': `url(${mask})`,
                  '--sand-c': (!cover.neutral && lines[index]?.color) || undefined,
                } as CSSProperties
              }
            />
          ))
        : cover && <i key={cover.urls[0]} className="pp-cover__art" style={{ backgroundImage: `url(${cover.urls[0]})` }} />}
      {meta.genre && <span className="pp-cover__label">{meta.genre}</span>}
    </div>
  );
}

interface CardProps {
  row: DecoratedRow;
  onOpen: () => void;
  onEdit: () => void;
  onExport: () => void;
  exporting: boolean;
  onDelete: () => void;
  /** Words on each of the last 30 days, today last; null until they are read. */
  recent: readonly number[] | null;
  /** The pointer came onto the card (true) or left it. */
  onPointAt: (pointed: boolean) => void;
}

function RowActions({ onEdit, onExport, exporting, onDelete }: Pick<CardProps, 'onEdit' | 'onExport' | 'exporting' | 'onDelete'>) {
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
        className="pp-act"
        onClick={onExport}
        disabled={exporting}
        aria-busy={exporting || undefined}
        title={t('projectPicker.desk.exportBook')}
        aria-label={t('projectPicker.desk.exportBook')}
      >
        <BrushIcon name={exporting ? 'loader' : 'arrow-out'} size={15} className={exporting ? 'ui-spin' : undefined} />
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

function ProjectCard({ row, onOpen, onEdit, onExport, exporting, onDelete, recent, onPointAt }: CardProps) {
  const { t, i18n } = useTranslation();
  const { project, meta, status, lastEditedRel, wordProgress, wordTarget } = row;
  const stats = project.stats;
  const title = project.name.trim() || t('projectPicker.desk.untitled');
  // The sample a first launch wrote lands on its own ring and waits, its rim
  // flowing, until it is opened; coming up from the first-run card, every
  // book is set down on the sea.
  const sample = useSampleOnShelf(project.id);
  const arriving = useFirstRunArrival();
  const [lands] = useState(sample.landing);
  const [arrives] = useState(arriving || lands);
  // On the sea the card's resting glass is drawn by the sea, so the water can
  // reach it; elsewhere it keeps its own CSS rim.
  const { attach: glassRef, drawn: seaDrawn, hoverProps: glassHover } = useCharSeaShape<HTMLElement>({
    rest: 0.85,
    radius: 2,
    arrive: arrives,
    waiting: sample.waiting,
  });
  const card = useRef<HTMLElement | null>(null);
  const attachCard = useCallback((element: HTMLElement | null) => {
    card.current = element;
    glassRef(element);
  }, [glassRef]);
  useEffect(() => {
    if (!lands || !seaDrawn) return undefined;
    markSampleLanded();
    const timer = window.setTimeout(() => {
      const rect = card.current?.getBoundingClientRect();
      if (rect) charSeaRegistry.drop(rect.left + rect.width / 2, rect.top + rect.height / 2, SAMPLE_LANDING_DROP);
    }, SAMPLE_LANDING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lands, seaDrawn]);
  const recentWords = recent ? recent.reduce((sum, words) => sum + words, 0) : 0;

  return (
    <article
      ref={attachCard}
      className={`pp-card glass glass--rest${sample.waiting ? ' glass--waiting' : ''}${seaDrawn ? ' pp-card--sea' : ''}`}
      data-char-sea-press=""
      {...glassHover}
      onMouseEnter={() => onPointAt(true)}
      onMouseLeave={() => onPointAt(false)}
    >
      <BookCover row={row} />
      <div className="pp-card__body">
        <div className="pp-card__head">
          <div className="pp-card__titles">
            <h3 className="pp-card__title">{title}</h3>
            {meta.subtitle && <div className="pp-card__subtitle">{meta.subtitle}</div>}
          </div>
          <RowActions onEdit={onEdit} onExport={onExport} exporting={exporting} onDelete={onDelete} />
        </div>
        {project.summary && <p className="pp-card__summary">{project.summary}</p>}
        <div className="pp-card__meta">
          <span>
            <b>{stats.wordsReady ? formatShelfWords(stats.words, i18n.language) : t('common.counting')}</b>
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
        {recent && (
          <div className="pp-card__strip">
            <div className="pp-card__progress-k">
              <span>{t('projectPicker.desk.recent')}</span>
              <span>{recentWords > 0 ? `+${recentWords.toLocaleString(i18n.language)} ${t('projectPicker.desk.wordsUnit')}` : '—'}</span>
            </div>
            <SandStrip
              daily={recent}
              seed={coverSeed(project.id)}
              label={t('projectPicker.desk.recentLabel', { words: recentWords.toLocaleString(i18n.language) })}
            />
          </div>
        )}
        {wordProgress !== null && (
          <div className="pp-card__progress">
            <div className="pp-card__progress-k">
              <span>{t('projectPicker.desk.progress')}</span>
              <span>
                {t('projectPicker.desk.goal', {
                  pct: Math.round(wordProgress),
                  target: formatShelfWords(wordTarget, i18n.language),
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

interface TransferError {
  /** Translation key. */
  title: string;
  message: string;
}

const IMPORT_ERROR_KEYS = {
  'not-a-book': 'projectPicker.bookTransfer.notABook',
  newer: 'projectPicker.bookTransfer.newer',
  'too-large': 'projectPicker.bookTransfer.tooLarge',
  invalid: 'projectPicker.bookTransfer.invalid',
  failed: 'projectPicker.bookTransfer.importFailed',
} as const;

function importErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof HostedQuotaExceededError) return error.message;
  if (error instanceof BookImportError) return t(IMPORT_ERROR_KEYS[error.code]);
  return t('projectPicker.bookTransfer.importFailed');
}

function TransferErrorDialog({ error, onClose }: { error: TransferError; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ModalRoot onClose={onClose} ariaLabel={t(error.title)}>
      <ModalCard className="pp-dialog" width={380}>
        <ModalHeader title={t(error.title)} />
        <ModalBody>
          <p role="alert">{error.message}</p>
        </ModalBody>
        <ModalActions>
          <Button onClick={onClose} autoFocus>
            {t('common.close')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}

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
  const { t, i18n } = useTranslation();
  const stats = project.stats;
  const title = t('projectPicker.desk.trashTitle', { name: project.name });
  return (
    <ModalRoot onClose={onClose} ariaLabel={title}>
      <ModalCard className="pp-dialog" width={420}>
        <ModalHeader title={title} />
        <ModalBody>
          <p>
            {t('projectPicker.trash.body', {
              words: stats.wordsReady ? stats.words.toLocaleString(i18n.language) : t('common.counting'),
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
  return platformShortcut('⌘↵', 'Ctrl+Enter');
}
