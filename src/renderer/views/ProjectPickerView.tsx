import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject, type ProjectSummary } from '../usecase/useProject';
import { useAuthStore } from '../store/auth';
import { SyncStatusHUD } from '../components/sync/SyncStatusHUD';
import '../../styles/project-picker.css';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ProjectPickerView');
log.setLevel(loglevel.levels.DEBUG);

type View = 'grid' | 'list';
type Filter = 'all' | 'active' | 'paused';
type Status = 'writing' | 'draft' | 'paused';

interface ProjectMeta {
  subtitle?: string;
  summary?: string;
  genre?: string;
}

const STATUS_LABEL: Record<Status, string> = {
  writing: '在写',
  draft:   '草稿',
  paused:  '搁置',
};

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

function formatRelative(iso: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const min = 60_000;
  const hr  = 60 * min;
  const day = 24 * hr;
  if (diff < min)         return '刚刚';
  if (diff < hr)          return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day)         return `${Math.floor(diff / hr)} 小时前`;
  if (diff < 2 * day)     return '昨天';
  if (diff < 30 * day)    return `${Math.floor(diff / day)} 天前`;
  if (diff < 365 * day)   return `${Math.floor(diff / (30 * day))} 月前`;
  return `${Math.floor(diff / (365 * day))} 年前`;
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
  if (days <= 7)  return 'writing';
  if (days <= 30) return 'draft';
  return 'paused';
}

function parseMeta(descriptionJson: string | null | undefined): ProjectMeta {
  if (!descriptionJson) return {};
  try {
    const parsed = JSON.parse(descriptionJson);
    if (parsed && typeof parsed === 'object') {
      return {
        subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
        summary:  typeof parsed.summary  === 'string' ? parsed.summary  : undefined,
        genre:    typeof parsed.genre    === 'string' ? parsed.genre    : undefined,
      };
    }
  } catch {
    /* descriptionJson may be free-form text from legacy projects; fall through */
  }
  return {};
}

function stringifyMeta(meta: ProjectMeta): string {
  const trimmed: ProjectMeta = {};
  if (meta.subtitle?.trim()) trimmed.subtitle = meta.subtitle.trim();
  if (meta.summary?.trim())  trimmed.summary  = meta.summary.trim();
  if (meta.genre?.trim())    trimmed.genre    = meta.genre.trim();
  return JSON.stringify(trimmed);
}

function formatWordsK(words: number): string {
  if (words < 1000) return String(words);
  return `${(words / 1000).toFixed(1)}k`;
}

interface ProjectFormState {
  name: string;
  subtitle: string;
  summary: string;
  genre: string;
}

export function ProjectPickerView() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const {
    loadProjectSummaries,
    createProject,
    updateProject,
    deleteProject,
  } = useProject({ userId: user?.id ?? '' });

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('grid');
  const [filter, setFilter] = useState<Filter>('all');
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
    return () => { active = false; };
  }, [user?.id, fetchProjects]);

  const decorated = useMemo(
    () => projects.map((p) => {
      const meta = parseMeta(p.descriptionJson);
      const status = statusFor(p.updatedAt);
      return {
        project: p,
        meta,
        status,
        colorToken: hashToColor(p.id),
        glyph: glyphFor(p.name),
        lastEditedRel: formatRelative(p.updatedAt),
        createdRel: formatCreated(p.createdAt),
      };
    }),
    [projects],
  );

  const filtered = decorated.filter(({ status }) =>
    filter === 'all' ||
    (filter === 'active' && (status === 'writing' || status === 'draft')) ||
    (filter === 'paused' && status === 'paused')
  );

  const counts = useMemo(() => ({
    all:     decorated.length,
    active:  decorated.filter((d) => d.status === 'writing' || d.status === 'draft').length,
    paused:  decorated.filter((d) => d.status === 'paused').length,
  }), [decorated]);

  const recent = useMemo(
    () => [...decorated].slice(0, 4),
    [decorated],
  );

  const handleOpen = useCallback((id: string) => {
    navigate(`/project/${id}`);
  }, [navigate]);

  const handleCreate = useCallback(async (form: ProjectFormState) => {
    if (busy) return;
    setBusy(true);
    try {
      const name = form.name.trim() || 'Untitled Project';
      const project = await createProject({ projectName: name });
      const meta: ProjectMeta = {
        subtitle: form.subtitle,
        summary: form.summary,
        genre: form.genre,
      };
      const description = stringifyMeta(meta);
      if (description !== '{}') {
        await updateProject(project.id, { name, descriptionJson: description });
      }
      setCreateOpen(false);
      navigate(`/project/${project.id}`);
    } catch (e) {
      log.error('Failed to create project:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, createProject, updateProject, navigate]);

  const handleEdit = useCallback(async (form: ProjectFormState) => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const name = form.name.trim() || editing.name;
      const description = stringifyMeta({
        subtitle: form.subtitle,
        summary: form.summary,
        genre: form.genre,
      });
      await updateProject(editing.id, { name, descriptionJson: description });
      await fetchProjects();
      setEditing(null);
    } catch (e) {
      log.error('Failed to update project:', e);
    } finally {
      setBusy(false);
    }
  }, [editing, busy, updateProject, fetchProjects]);

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

  if (loading) {
    return (
      <div className="pp">
        <div className="pp__inner">
          <div className="pp-empty">Loading projects…</div>
        </div>
        <SyncStatusHUD />
      </div>
    );
  }

  const userInitial = (user?.name?.trim() || user?.email?.trim() || '·')[0].toUpperCase();

  return (
    <div className="pp">
      <div className="pp__inner">

        {/* ─── Header ─── */}
        <header className="pp-head">
          <div>
            <div className="pp-head__kicker">
              <span className="pp-head__kicker-dot" />
              <span>YOUR WORKSPACE</span>
              <span className="pp-head__kicker-sep">·</span>
              <span>DRIFTING WRITING STUDIO</span>
            </div>
            <h1 className="pp-head__title"><em>书架</em> Bookshelf</h1>
            <p className="pp-head__sub">在此切换、新建、整理你的所有写作项目。</p>
          </div>
          <aside className="pp-head__aside">
            <div className="pp-head__user">
              <div className="pp-head__user-name">
                <div className="pp-head__user-name-main">
                  {user?.name || user?.email || 'Drifting'}
                </div>
                <div className="pp-head__user-name-plan">DRIFTING · WORKSPACE</div>
              </div>
              <div className="pp-head__user-avatar">{userInitial}</div>
            </div>
          </aside>
        </header>

        {/* ─── Recent strip ─── */}
        {recent.length > 0 && (
          <section className="pp-section">
            <div className="pp-section__head">
              <div className="pp-section__title">
                <span className="pp-section__title-mark">✦</span>
                <span className="pp-section__title-cn">最近</span>
                <span className="pp-section__title-en">Recently opened</span>
              </div>
              <span className="pp-section__count">· {recent.length}</span>
            </div>
            <div className="pp-recent">
              {recent.map(({ project, status, colorToken, glyph, lastEditedRel }) => (
                <div
                  key={project.id}
                  className="pp-recent__card"
                  style={{ ['--pp-c' as string]: `var(${colorToken})` }}
                  onClick={() => handleOpen(project.id)}
                >
                  <span className="pp-recent__kicker">{STATUS_LABEL[status]}</span>
                  <div className="pp-recent__title">
                    <em>{glyph}</em>
                    {project.name}
                  </div>
                  <span className="pp-recent__last">
                    最近编辑 · <b>{lastEditedRel}</b>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── Toolbar ─── */}
        <div className="pp-toolbar">
          <div className="pp-toolbar__chips">
            {([
              ['all',    '全部',   counts.all],
              ['active', '进行中', counts.active],
              ['paused', '搁置',   counts.paused],
            ] as Array<[Filter, string, number]>).map(([k, label, n]) => (
              <div
                key={k}
                className={`pp-toolbar__chip ${filter === k ? 'pp-toolbar__chip--active' : ''}`}
                onClick={() => setFilter(k)}
              >
                <span>{label}</span><em>· {n}</em>
              </div>
            ))}
          </div>
          <div className="pp-toolbar__actions">
            <div className="pp-toolbar__view">
              <button
                className={`pp-toolbar__view-btn ${view === 'grid' ? 'pp-toolbar__view-btn--active' : ''}`}
                onClick={() => setView('grid')}
              >⊞ 卡片</button>
              <button
                className={`pp-toolbar__view-btn ${view === 'list' ? 'pp-toolbar__view-btn--active' : ''}`}
                onClick={() => setView('list')}
              >☰ 列表</button>
            </div>
            <button
              className="pp-toolbar__btn pp-toolbar__btn--accent"
              onClick={() => setCreateOpen(true)}
            >
              <span className="pp-toolbar__btn-glyph">＋</span> 新项目
            </button>
          </div>
        </div>

        {/* ─── All projects ─── */}
        <section className="pp-section">
          <div className="pp-section__head">
            <div className="pp-section__title">
              <span className="pp-section__title-mark">¶</span>
              <span className="pp-section__title-cn">全部项目</span>
              <span className="pp-section__title-en">All projects</span>
            </div>
            <span className="pp-section__count">
              {filtered.length} / {decorated.length} 本
            </span>
          </div>

          {decorated.length === 0 ? (
            <div className="pp-empty">
              还没有项目 — 点击右上角的「+ 新项目」开始写。
            </div>
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
              <div className="pp-card pp-card--new" onClick={() => setCreateOpen(true)}>
                <div className="pp-card__spine">
                  <div>
                    <div className="pp-card--new__glyph">＋</div>
                    <div className="pp-card--new__label">
                      新建项目<br/>NEW BOOK
                    </div>
                  </div>
                </div>
                <div className="pp-card__body">
                  <div className="pp-card__title" style={{ color: 'hsl(var(--ink-4))' }}>
                    一本新书 · 从这里开始
                  </div>
                </div>
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
              >
                <span className="pp-list__glyph" style={{ color: 'hsl(var(--ink-4))' }}>＋</span>
                <div className="pp-list__title">
                  <span
                    className="pp-list__title-main"
                    style={{ color: 'hsl(var(--ink-4))' }}
                  >
                    新建项目 · NEW BOOK
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>

        <footer className="pp-foot">
          <span>Drifting Writing Studio</span>
          <span className="pp-foot__orn">⁂</span>
          <span>{user?.email || 'local'}</span>
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

interface DecoratedRow {
  project: ProjectSummary;
  meta: ProjectMeta;
  status: Status;
  colorToken: string;
  glyph: string;
  lastEditedRel: string;
  createdRel: string;
}

interface CardProps {
  row: DecoratedRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ProjectCard({ row, onOpen, onEdit, onDelete }: CardProps) {
  const { project, meta, status, colorToken, glyph, lastEditedRel } = row;
  const stats = project.stats;
  const sourceLabel = project.source === 'server' ? 'CLOUD · SYNCED' : 'LOCAL · 草稿';
  const spineLine = meta.genre || sourceLabel;

  return (
    <div
      className="pp-card"
      style={{ ['--pp-c' as string]: `var(${colorToken})` }}
      onClick={onOpen}
    >
      <div className="pp-card__menu" onClick={(e) => e.stopPropagation()}>
        <span className="pp-card__menu-btn" onClick={onEdit} title="编辑">✎</span>
        <span className="pp-card__menu-btn" onClick={onDelete} title="删除">×</span>
      </div>
      <div className="pp-card__spine">
        <div className="pp-card__spine-top">
          <span className="pp-card__spine-mark">{spineLine}</span>
          <span className="pp-card__spine-glyph">{glyph}</span>
        </div>
        <div>
          <h2 className="pp-card__spine-title">{project.name}</h2>
          {meta.subtitle && (
            <div className="pp-card__spine-sub">— {meta.subtitle}</div>
          )}
          <div className="pp-card__spine-foot" style={{ marginTop: 14 }}>
            <span><b>{formatWordsK(stats.words)}</b> 字</span>
            <span>{stats.nodes} 章</span>
          </div>
        </div>
      </div>
      <div className="pp-card__body">
        <div className="pp-card__title">
          <em>《</em>{project.name}<em>》</em>
          {meta.subtitle ? ` · ${meta.subtitle}` : ''}
        </div>
        <div className="pp-card__meta">
          <span><b>{stats.storylines}</b>线</span>
          <span><b>{stats.elements}</b>元素</span>
          <span><b>{stats.categories}</b>类</span>
        </div>
        <div className="pp-card__progress">
          <div
            className="pp-card__progress-fill"
            style={{ width: `${Math.min(100, stats.nodes > 0 ? 100 : 0)}%`, opacity: stats.words > 0 ? 1 : 0.25 }}
          />
        </div>
        <div className={`pp-card__status pp-card__status--${status}`}>
          {STATUS_LABEL[status]} · {lastEditedRel}
        </div>
      </div>
    </div>
  );
}

function ProjectListRow({ row, onOpen, onEdit, onDelete }: CardProps) {
  const { project, meta, status, colorToken, glyph, lastEditedRel } = row;
  const stats = project.stats;
  const subline = meta.genre
    || (project.source === 'server' ? 'CLOUD · SYNCED' : 'LOCAL · 草稿');

  return (
    <div
      className="pp-list__row"
      style={{ ['--pp-c' as string]: `var(${colorToken})` }}
      onClick={onOpen}
    >
      <span className="pp-list__glyph">{glyph}</span>
      <div className="pp-list__title">
        <span className="pp-list__title-main">
          <em>《</em>{project.name}<em>》</em>
        </span>
        <span className="pp-list__title-sub">{subline}</span>
      </div>
      <div className="pp-list__sub">
        {meta.summary || meta.subtitle || '—'}
      </div>
      <div className="pp-list__cell">
        <span className="pp-list__cell-v">
          {(stats.words / 1000).toFixed(1)}<em>k</em>
        </span>
        <span className="pp-list__cell-k">字</span>
      </div>
      <div className="pp-list__cell">
        <span className="pp-list__cell-v">
          {stats.nodes}<em>章</em>
        </span>
        <span className="pp-list__cell-k">章 · 节点</span>
      </div>
      <div className="pp-list__cell">
        <span
          className="pp-list__cell-v"
          style={{ fontStyle: 'italic', color: 'hsl(var(--ink-2))' }}
        >
          {lastEditedRel}
        </span>
        <span className="pp-list__cell-k">{STATUS_LABEL[status]}</span>
      </div>
      <div className="pp-list__menu" onClick={(e) => e.stopPropagation()}>
        <span
          className="pp-list__menu-btn"
          onClick={onEdit}
          title="编辑"
        >✎</span>
        <span
          className="pp-list__menu-btn"
          onClick={onDelete}
          title="删除"
        >×</span>
      </div>
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
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal__head">
          <div className="pp-modal__kicker">DELETE PROJECT · 删除项目</div>
          <h2 className="pp-modal__title">
            确认删除 <em>《{project.name}》</em>？
          </h2>
        </div>
        <div className="pp-modal__body">
          <p className="pp-modal__sub">
            删除后将无法恢复。{stats.words.toLocaleString()} 字 · {stats.nodes} 章 · {stats.elements} 个元素都会移除。
          </p>
        </div>
        <div className="pp-modal__foot">
          <button className="pp-modal__btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="pp-modal__btn pp-modal__btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '删除中…' : '删除'}
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
  const initialMeta = parseMeta(project?.descriptionJson);
  const [form, setForm] = useState<ProjectFormState>({
    name:     project?.name ?? '',
    subtitle: initialMeta.subtitle ?? '',
    summary:  initialMeta.summary  ?? '',
    genre:    initialMeta.genre    ?? '',
  });

  const set = <K extends keyof ProjectFormState>(key: K) =>
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
  const submitLabel = isEdit ? (busy ? '保存中…' : '保存') : (busy ? '创建中…' : '新建');

  return (
    <div className="pp-modal-backdrop" onClick={onClose}>
      <div
        className="pp-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 540 }}
      >
        <div className="pp-modal__head">
          <div className="pp-modal__kicker">
            {isEdit ? 'EDIT PROJECT · 编辑项目' : 'NEW PROJECT · 新项目'}
          </div>
          <h2 className="pp-modal__title">
            {isEdit
              ? <>编辑 <em>《{project?.name}》</em></>
              : <>新建 <em>一本书</em></>}
          </h2>
        </div>
        <div className="pp-modal__body">
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">名字 · TITLE</span>
            <input
              className="pp-modal__input"
              placeholder="例：渡舟"
              value={form.name}
              onChange={set('name')}
              autoFocus
            />
          </div>
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">副标 · SUBTITLE</span>
            <input
              className="pp-modal__input"
              placeholder="例：多视角长篇 · 一九三七至今"
              value={form.subtitle}
              onChange={set('subtitle')}
            />
          </div>
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">体裁 · GENRE</span>
            <input
              className="pp-modal__input"
              placeholder="长篇 · 文学"
              value={form.genre}
              onChange={set('genre')}
            />
          </div>
          <div className="pp-modal__field">
            <span className="pp-modal__field-k">梗概 · SUMMARY</span>
            <textarea
              className="pp-modal__textarea"
              placeholder="一两句话说明这本书是什么。"
              value={form.summary}
              onChange={set('summary')}
            />
          </div>
        </div>
        <div className="pp-modal__foot">
          <button className="pp-modal__btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
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
