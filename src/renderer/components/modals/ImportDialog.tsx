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
import { FileText, Folder, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useBookNode } from '../../usecase/useBookNode';
import { useBookElement } from '../../usecase/useBookElement';
import { CHAPTER_ORDER_STRIDE, isChapter } from '../../domain/book-node';
import { inferFormat, parseFile, type ImportTarget, type ParsedDoc } from '../../services/import';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

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
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((s) => s.user?.id);

  // Usecases — these hooks must be called unconditionally even when the
  // dialog is closed (Rules of Hooks). They no-op without a valid project.
  const safeProjectId = projectId ?? '__no_project__';
  const safeUserId = userId ?? '__no_user__';
  const nodeUsecases = useBookNode({ projectId: safeProjectId, userId: safeUserId });
  const elementUsecases = useBookElement({ projectId: safeProjectId, userId: safeUserId });

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

  const requestClose = useCallback(() => {
    if (!running) onClose();
  }, [onClose, running]);

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

  useEffect(() => {
    if (!open || running) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose, running]);

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

  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id));

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
          await nodeUsecases.createNode({
            kind: 'chapter',
            title,
            mainStorylineId: storylineId,
            bookOrder: nextOrder,
            initialContentJson: docJson,
          });
          nextOrder += CHAPTER_ORDER_STRIDE;
        } else if (target === 'inspiration') {
          await nodeUsecases.createNode({
            kind: 'drift',
            title,
            mainStorylineId: null,
            bookOrder: null,
            initialContentJson: docJson,
          });
        } else if (target === 'element') {
          if (!categoryId) throw new Error('Category required');
          await elementUsecases.createElement({
            name: title,
            categoryId,
            initialContentJson: docJson,
          });
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
    <ModalRoot
      onClose={requestClose}
      ariaLabel={t('importDialog.title')}
      closeOnBackdrop={!running}
      dismissOnEscape={!running}
    >
      <ModalCard width={640}>
        <ModalHeader
          title={t('importDialog.title')}
          description={
            <>
              {t('importDialog.descriptionA')} <code>.md</code> / <code>.docx</code> /{' '}
              <code>.txt</code>。{t('importDialog.descriptionB')}
            </>
          }
          onClose={running ? undefined : requestClose}
          closeLabel={running ? t('importDialog.closeBlocked') : t('settings.close')}
        />
        <ModalBody>

        {/* Target type */}
        <section style={{ marginBottom: 16 }}>
          <div className="set-sec__title" style={{ marginBottom: 10 }}>
            {t('importDialog.targetTitle')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['chapter', 'element', 'inspiration'] as const).map((targetKind) => (
              <button
                key={targetKind}
                type="button"
                onClick={() => setTarget(targetKind)}
                disabled={running}
                className={'set-tier' + (target === targetKind ? ' set-tier--active' : '')}
                style={{ flex: 1, textAlign: 'left' }}
              >
                <div className="set-tier__name">
                  {t(`importDialog.targets.${targetKind}.label`)}
                </div>
                <div className="set-tier__desc">{t(`importDialog.targets.${targetKind}.desc`)}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Target-specific config */}
        {target === 'chapter' && (
          <section style={{ marginBottom: 16 }}>
            <div className="set-sec__title" style={{ marginBottom: 6 }}>
              {t('importDialog.storylineTitle')}
            </div>
            {storylines.length === 0 ? (
              <div style={{ fontSize: 12, color: 'hsl(var(--accent))' }}>
                {t('importDialog.noStorylines')}
              </div>
            ) : (
              <select
                className="set-input"
                style={{ minWidth: '100%' }}
                value={storylineId ?? ''}
                disabled={running}
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
            <div className="set-sec__title" style={{ marginBottom: 6 }}>
              {t('importDialog.categoryTitle')}
            </div>
            {categories.length === 0 ? (
              <div style={{ fontSize: 12, color: 'hsl(var(--accent))' }}>
                {t('importDialog.noCategories')}
              </div>
            ) : (
              <select
                className="set-input"
                style={{ minWidth: '100%' }}
                value={categoryId ?? ''}
                disabled={running}
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
          <div className="set-sec__title" style={{ marginBottom: 10 }}>
            {t('importDialog.filesTitle')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="set-btn" onClick={onPickFiles} disabled={running}>
              <FileText size={13} style={{ marginRight: 4 }} /> {t('importDialog.chooseFiles')}
            </button>
            <button type="button" className="set-btn" onClick={onPickFolder} disabled={running}>
              <Folder size={13} style={{ marginRight: 4 }} /> {t('importDialog.chooseFolder')}
            </button>
            <span style={{ flex: 1 }} />
            {items.length > 0 && (
              <button
                type="button"
                className="set-btn set-btn--ghost"
                onClick={() => setItems([])}
                disabled={running}
              >
                {t('importDialog.clear')}
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
            // @ts-expect-error — non-standard but supported by the embedded webview
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
                    {t(`importDialog.status.${it.status}`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeItem(it.id)}
                    disabled={running}
                    style={{
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      color: 'hsl(var(--ink-4))',
                    }}
                    title={t('common.delete')}
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
            {t('importDialog.summary.done')} · {t('importDialog.summary.ok')} <b>{summary.ok}</b>
            {summary.failed > 0 && (
              <>
                {' · '}
                {t('importDialog.summary.failed')}{' '}
                <b style={{ color: 'hsl(var(--accent))' }}>{summary.failed}</b>
              </>
            )}
          </div>
        )}

        </ModalBody>
        <ModalActions>
          <Button variant="default" onClick={requestClose} disabled={running}>
            {t('settings.close')}
          </Button>
          <Button
            variant="primary"
            onClick={commit}
            disabled={running || !canCommit}
          >
            {running
              ? t('importDialog.importing')
              : t('importDialog.start', {
                  count: items.filter((it) => it.status === 'ready').length,
                })}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
