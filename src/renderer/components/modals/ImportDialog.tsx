/**
 * ImportDialog — picks a target type, gathers files, parses them, then
 * commits as new entities via the project usecases.
 *
 * Single-type per import is intentional. A file maps to one of:
 *   chapter      → new BookNode, mainStorylineId = selected storyline
 *   element      → new BookElement, categoryId = selected category
 *   inspiration  → new BookNode, mainStorylineId = null (drift node)
 *
 * File sources:
 *   - "Select files" → multi-file picker, .md/.markdown/.docx/.txt only
 *   - "Select folder" → all files in folder (recursive, filtered by ext)
 *
 * Parsing is per-format and lazy-imported (see services/import). The
 * dialog runs each file through `parseFile`, lets the user edit the
 * inferred title, then commits the whole batch on click.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, FileText, Folder, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useBookNode } from '../../usecase/useBookNode';
import { useBookElement } from '../../usecase/useBookElement';
import { useBookContent } from '../../usecase/useBookContent';
import { CHAPTER_ORDER_STRIDE, isChapter } from '../../domain/book-node';
import {
  inferFormat,
  parseFile,
  TARGET_DESC,
  TARGET_LABEL,
  type ImportTarget,
  type ParsedDoc,
} from '../../services/import';

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

interface QueuedItem {
  id: string; // local — UI key + identity through pipeline
  filename: string;
  status: 'pending' | 'parsing' | 'ready' | 'committed' | 'error';
  title?: string; // editable, defaults to parsed.guessedTitle
  parsed?: ParsedDoc;
  error?: string;
}

const ACCEPTED_EXTS = ['.md', '.markdown', '.txt', '.docx'];

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((s) => s.user?.id);

  // Usecases — these hooks must be called unconditionally even when the
  // dialog is closed (Rules of Hooks). They no-op without a valid project.
  const safeProjectId = projectId ?? '__no_project__';
  const safeUserId = userId ?? '__no_user__';
  const nodeUsecases = useBookNode({ projectId: safeProjectId, userId: safeUserId });
  const elementUsecases = useBookElement({ projectId: safeProjectId, userId: safeUserId });
  const contentUsecases = useBookContent({ projectId: safeProjectId, userId: safeUserId });

  // Domain data needed for target-specific pickers.
  const storylines = useDataStore((s) => s.storylines);
  const categories = useDataStore((s) => s.bookElementCategories);
  const bookNodes = useDataStore((s) => s.bookNodes);

  const [target, setTarget] = useState<ImportTarget>('chapter');
  const [items, setItems] = useState<QueuedItem[]>([]);
  const [storylineId, setStorylineId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ ok: number; failed: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Default-select first storyline / category when they load.
  useEffect(() => {
    if (storylineId === null && storylines.length > 0) {
      setStorylineId(storylines[0].id);
    }
  }, [storylines, storylineId]);
  useEffect(() => {
    if (categoryId === null && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [categories, categoryId]);

  // Reset state when closed/reopened.
  useEffect(() => {
    if (!open) {
      setItems([]);
      setRunning(false);
      setSummary(null);
    }
  }, [open]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => {
      const name = f.name.toLowerCase();
      return ACCEPTED_EXTS.some((ext) => name.endsWith(ext));
    });
    if (arr.length === 0) return;

    // Append as 'parsing' first so user sees progress.
    const fresh: QueuedItem[] = arr.map((f) => ({
      id: `${Date.now()}-${f.name}-${Math.random().toString(36).slice(2, 6)}`,
      filename: f.name,
      status: 'parsing',
    }));
    setItems((prev) => [...prev, ...fresh]);

    // Parse sequentially — keeps memory low and surfaces errors cleanly.
    for (let i = 0; i < arr.length; i++) {
      const file = arr[i];
      const placeholder = fresh[i];
      try {
        const parsed = await parseFile(file);
        setItems((prev) =>
          prev.map((it) =>
            it.id === placeholder.id
              ? { ...it, status: 'ready', parsed, title: parsed.guessedTitle }
              : it,
          ),
        );
      } catch (err) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === placeholder.id
              ? { ...it, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : it,
          ),
        );
      }
    }
  }, []);

  const onPickFiles = () => fileInputRef.current?.click();
  const onPickFolder = () => folderInputRef.current?.click();

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((it) => it.id !== id));

  // ─── Commit ───────────────────────────────────────────────────────

  const canCommit = useMemo(() => {
    if (!projectId || !userId) return false;
    if (items.length === 0) return false;
    if (items.every((it) => it.status !== 'ready')) return false;
    if (target === 'chapter' && !storylineId) return false;
    if (target === 'element' && !categoryId) return false;
    return true;
  }, [items, target, storylineId, categoryId, projectId, userId]);

  const commit = async () => {
    setRunning(true);
    let ok = 0;
    let failed = 0;

    // Chapter imports append after the current max bookOrder. We snapshot
    // once so a 50-file import stays monotonically ordered even as creations
    // come back interleaved with React state. `isChapter` narrows the pool
    // to nodes with a non-nullable bookOrder so the math is plain.
    const chapterPool = bookNodes.filter(isChapter);
    let nextOrder =
      chapterPool.length > 0
        ? Math.max(...chapterPool.map((n) => n.bookOrder)) + CHAPTER_ORDER_STRIDE
        : 0;

    const readyItems = items.filter((it) => it.status === 'ready' && it.parsed);
    for (const item of readyItems) {
      try {
        const title = (item.title?.trim() || item.parsed?.guessedTitle || item.filename).slice(
          0,
          200,
        );
        const docJson = JSON.stringify(item.parsed?.doc ?? { type: 'doc', content: [] });

        if (target === 'chapter') {
          if (!storylineId) throw new Error('Storyline required');
          const created = await nodeUsecases.createNode({
            title,
            mainStorylineId: storylineId,
            bookOrder: nextOrder,
          });
          await contentUsecases.updateContentByNodeId(created.id, { contentJson: docJson });
          nextOrder += CHAPTER_ORDER_STRIDE;
        } else if (target === 'inspiration') {
          const created = await nodeUsecases.createNode({
            title,
            mainStorylineId: null,
            bookOrder: null,
          });
          await contentUsecases.updateContentByNodeId(created.id, { contentJson: docJson });
        } else if (target === 'element') {
          if (!categoryId) throw new Error('Category required');
          const created = await elementUsecases.createElement({ name: title, categoryId });
          await elementUsecases.updateElement(created.id, { contentJson: docJson });
        }

        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'committed' } : it)),
        );
        ok += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'error', error: msg } : it)),
        );
        failed += 1;
      }
    }

    setSummary({ ok, failed });
    setRunning(false);
  };

  if (!open) return null;

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 80px)',
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 8,
          padding: 24,
          fontFamily: 'var(--font-sans)',
          color: 'hsl(var(--ink-1))',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 22,
              fontWeight: 400,
              margin: 0,
            }}
          >
            导入文件
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'hsl(var(--ink-3))' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'hsl(var(--ink-3))', marginTop: 8, marginBottom: 18 }}>
          每次导入只能选一种类型，支持 <code>.md</code> / <code>.docx</code> / <code>.txt</code>。
          可以选多个文件或一个文件夹（仅取支持的扩展名）。
        </p>

        {/* Target type */}
        <section style={{ marginBottom: 16 }}>
          <div className="set-sec__title" style={{ marginBottom: 10 }}>类型 · TARGET</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['chapter', 'element', 'inspiration'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTarget(t)}
                className={'set-tier' + (target === t ? ' set-tier--active' : '')}
                style={{ flex: 1, textAlign: 'left' }}
              >
                <div className="set-tier__name">{TARGET_LABEL[t]}</div>
                <div className="set-tier__desc">{TARGET_DESC[t]}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Target-specific config */}
        {target === 'chapter' && (
          <section style={{ marginBottom: 16 }}>
            <div className="set-sec__title" style={{ marginBottom: 6 }}>归属故事线</div>
            {storylines.length === 0 ? (
              <div style={{ fontSize: 12, color: 'hsl(var(--accent))' }}>
                项目里还没有故事线。请先创建一条，或选择「浮缀」导入。
              </div>
            ) : (
              <select
                className="set-input"
                style={{ minWidth: '100%' }}
                value={storylineId ?? ''}
                onChange={(e) => setStorylineId(e.target.value)}
              >
                {storylines.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </section>
        )}

        {target === 'element' && (
          <section style={{ marginBottom: 16 }}>
            <div className="set-sec__title" style={{ marginBottom: 6 }}>归属类别</div>
            {categories.length === 0 ? (
              <div style={{ fontSize: 12, color: 'hsl(var(--accent))' }}>
                项目里还没有元素类别。请先创建一个。
              </div>
            ) : (
              <select
                className="set-input"
                style={{ minWidth: '100%' }}
                value={categoryId ?? ''}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </section>
        )}

        {/* File picker */}
        <section style={{ marginBottom: 16 }}>
          <div className="set-sec__title" style={{ marginBottom: 10 }}>文件 · FILES</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="set-btn" onClick={onPickFiles}>
              <FileText size={13} style={{ marginRight: 4 }} /> 选择文件
            </button>
            <button className="set-btn" onClick={onPickFolder}>
              <Folder size={13} style={{ marginRight: 4 }} /> 选择文件夹
            </button>
            <span style={{ flex: 1 }} />
            {items.length > 0 && (
              <button className="set-btn set-btn--ghost" onClick={() => setItems([])}>
                清空
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTS.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.target.files;
              if (files) void addFiles(files);
              e.target.value = ''; // allow re-selecting same files
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — non-standard but supported in Electron/Chromium
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.target.files;
              if (files) void addFiles(files);
              e.target.value = '';
            }}
          />
        </section>

        {/* Queue */}
        {items.length > 0 && (
          <section
            style={{
              border: '1px solid hsl(var(--rule))',
              borderRadius: 5,
              overflow: 'hidden auto',
              marginBottom: 16,
              maxHeight: 240,
            }}
          >
            {items.map((it) => {
              const fmt = inferFormat(it.filename);
              return (
                <div
                  key={it.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '20px 60px 1fr 100px 24px',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderBottom: '1px dotted hsl(var(--rule))',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: 'hsl(var(--ink-4))' }}>
                    {it.status === 'committed' ? (
                      <CheckCircle2 size={14} color="hsl(var(--story-3))" />
                    ) : it.status === 'error' ? (
                      <AlertCircle size={14} color="hsl(var(--accent))" />
                    ) : (
                      <FileText size={14} />
                    )}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'hsl(var(--ink-4))',
                      textTransform: 'uppercase',
                    }}
                  >
                    {fmt ?? '?'}
                  </span>
                  <input
                    className="set-input"
                    style={{ minWidth: 0, width: '100%', fontSize: 12, padding: '3px 6px' }}
                    value={it.title ?? it.filename}
                    placeholder={it.filename}
                    disabled={it.status !== 'ready'}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((p) => (p.id === it.id ? { ...p, title: e.target.value } : p)),
                      )
                    }
                    title={it.error ?? it.filename}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color:
                        it.status === 'error'
                          ? 'hsl(var(--accent))'
                          : it.status === 'committed'
                            ? 'hsl(var(--story-3))'
                            : 'hsl(var(--ink-4))',
                      textTransform: 'uppercase',
                    }}
                  >
                    {it.status}
                  </span>
                  <button
                    onClick={() => removeItem(it.id)}
                    style={{
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      color: 'hsl(var(--ink-4))',
                    }}
                    title="移除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {summary && (
          <div
            style={{
              padding: 10,
              background: 'hsl(var(--paper-deep))',
              borderRadius: 4,
              fontSize: 12,
              color: 'hsl(var(--ink-2))',
              marginBottom: 12,
            }}
          >
            完成 · 成功 <b>{summary.ok}</b>
            {summary.failed > 0 && (
              <>
                {' · '}
                失败 <b style={{ color: 'hsl(var(--accent))' }}>{summary.failed}</b>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 'auto' }}>
          <button className="set-btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="set-btn set-btn--primary"
            onClick={commit}
            disabled={running || !canCommit}
          >
            {running ? '导入中…' : `开始导入 (${items.filter((it) => it.status === 'ready').length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
