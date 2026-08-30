import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { Comment } from '../../domain/comment';
import { createPlainCommentDoc, extractTextFromCommentBody } from '../../domain/comment';
import type { LibraryItemKind } from '../../domain/library-item';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { CollapsibleFooter } from '../../components/ui/CollapsibleFooter';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { platform } from '../../platform';
import { canUseExternalContent } from '../../lib/config';
import type { CreateLibraryItemInput } from '../../usecase/useLibraryItem';
import { FilterPill, type FocusedEntity } from './LibraryPanel';
import { useEscapeToClose } from './library-item-media';

export function ResolvedTodoArchive({
  todos,
  onReopen,
  onDelete,
}: {
  todos: Comment[];
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <CollapsibleFooter
      label={t('memoMaterial.archive.done')}
      count={todos.length}
      expandTitle={t('memoMaterial.archive.expandDone')}
      collapseTitle={t('memoMaterial.archive.collapseDone')}
      bodyStyle={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {todos.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'hsl(var(--ink-4))',
            fontStyle: 'italic',
            padding: '8px 4px',
          }}
        >
          {t('memoMaterial.archive.noDone')}
        </div>
      )}
      {todos.map((todo) => (
        <div
          key={todo.id}
          className="resolved-todo-archive__row"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '4px 6px',
            borderRadius: 3,
            fontSize: 12,
            color: 'hsl(var(--ink-3))',
            opacity: 0.7,
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: 'var(--font-sans)',
              textDecoration: 'line-through',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {extractTextFromCommentBody(todo.bodyJson) || t('memoMaterial.todo.empty')}
          </div>
          <button
            onClick={() => onReopen(todo.id)}
            title={t('memoMaterial.archive.reopen')}
            aria-label={t('memoMaterial.archive.reopen')}
            className="resolved-todo-archive__action"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'hsl(var(--ink-4))',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '0 4px',
            }}
          >
            ↺
          </button>
          <button
            onClick={() => onDelete(todo.id)}
            title={t('common.delete')}
            aria-label={t('common.delete')}
            className="resolved-todo-archive__action"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'hsl(var(--ink-4))',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </CollapsibleFooter>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose dialogs

export function ComposeTodoDialog({
  focused,
  kind = 'todo',
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  kind?: 'note' | 'todo';
  onCancel: () => void;
  onCreate: (body: string, relations: RelationTarget[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  useEscapeToClose(true, onCancel);
  const [body, setBody] = useState('');
  const [relations, setRelations] = useState<RelationTarget[]>(() =>
    focused.kind && focused.id && isStructuralEntityKind(focused.kind)
      ? [{ kind: focused.kind, id: focused.id, label: t('memoMaterial.dialog.currentItem') }]
      : [],
  );
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.kind}:${r.id}`)),
    [relations],
  );

  return (
    <DialogShell
      title={
        kind === 'todo' ? t('memoMaterial.dialog.newTodo') : t('reviewPanel.newComment')
      }
      onCancel={onCancel}
    >
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          kind === 'todo'
            ? t('memoMaterial.dialog.todoPlaceholder')
            : t('reviewPanel.commentPlaceholder')
        }
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void onCreate(body, relations);
          }
        }}
        style={dialogTextareaStyle}
      />
      <div style={{ marginTop: 10 }}>
        <EntityRelationPicker
          selected={selectedSet}
          selectedChipMode="toggle"
          onAdd={(t) => setRelations((prev) => [...prev, t])}
          onRemove={(t) =>
            setRelations((prev) => prev.filter((r) => !(r.kind === t.kind && r.id === t.id)))
          }
        />
      </div>
      <DialogActions
        onCancel={onCancel}
        onConfirm={() => onCreate(body, relations)}
        confirmDisabled={!body.trim()}
      />
    </DialogShell>
  );
}

const dialogTextareaStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  padding: '6px 8px',
  borderRadius: 3,
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  outline: 'none',
  resize: 'vertical',
  boxSizing: 'border-box',
};

export function ComposeLibraryItemDialog({
  focused,
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  onCancel: () => void;
  onCreate: (input: CreateLibraryItemInput, relations: RelationTarget[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LibraryItemKind>('url');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [pickedSourcePath, setPickedSourcePath] = useState<string | null>(null);
  const [urlMeta, setUrlMeta] = useState<{
    title: string | null;
    ogImage: string | null;
    favicon: string | null;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const titleAutoFilled = useRef(false);
  const ownedImportPathRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const submitInFlightRef = useRef(false);
  const pickerInFlightRef = useRef(false);
  const [relations, setRelations] = useState<RelationTarget[]>(() =>
    // Pre-fill the new comment / library item with the currently-focused entity, but
    // only when it's a valid relation target (structural). If the user is
    // looking at a comment / library item themselves, skip the pre-fill — those
    // kinds aren't legal toKinds.
    focused.kind && focused.id && isStructuralEntityKind(focused.kind)
      ? [{ kind: focused.kind, id: focused.id, label: t('memoMaterial.dialog.currentItem') }]
      : [],
  );
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.kind}:${r.id}`)),
    [relations],
  );

  const deleteOwnedImport = useCallback(async () => {
    const filePath = ownedImportPathRef.current;
    if (!filePath) return;
    const deleted = await platform.material.deleteImport(filePath);
    if (!deleted.ok) throw new Error(deleted.error);
    if (ownedImportPathRef.current === filePath) ownedImportPathRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (submitInFlightRef.current) return;
      const filePath = ownedImportPathRef.current;
      ownedImportPathRef.current = null;
      if (!filePath) return;
      void platform.material
        .deleteImport(filePath)
        .then((deleted) => {
          if (!deleted.ok) {
            console.warn('[material] failed to clean abandoned picker import:', deleted.error);
          }
        })
        .catch((error) => {
          console.warn('[material] failed to clean abandoned picker import:', error);
        });
    };
  }, []);

  // Debounce-resolve the URL meta as the user pastes / types. Pre-fills the
  // title if the user hasn't typed one (or only kept the value we auto-filled),
  // and stashes og:image for the thumbnail slot on submit.
  useEffect(() => {
    if (kind !== 'url') return;
    const trimmed = url.trim();
    let cancelled = false;
    if (!/^https?:\/\//i.test(trimmed) || !canUseExternalContent()) {
      // Bail early; clear stale meta on the next microtask so we don't
      // synchronously call setState inside the effect body.
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setUrlMeta(null);
        setResolving(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(async () => {
      setResolving(true);
      const res = await platform.material.resolveUrlMeta(trimmed);
      if (cancelled) return;
      setResolving(false);
      if (!res.ok) {
        setUrlMeta(null);
        return;
      }
      setUrlMeta({ title: res.title, ogImage: res.ogImage, favicon: res.favicon });
      if (res.title && (!title || titleAutoFilled.current)) {
        titleAutoFilled.current = true;
        setTitle(res.title);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Intentional: don't restart fetch when `title` flips from auto-fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  const pickFile = async (pickerKind: 'image' | 'pdf' | 'any') => {
    if (submitting || pickerInFlightRef.current) return;
    pickerInFlightRef.current = true;
    setPicking(true);
    setOperationError(null);
    let unownedPickedPath: string | null = null;
    try {
      const res = await platform.material.pickFile(pickerKind);
      if (!res.ok) {
        if (!res.canceled) {
          const message =
            res.code === 'MATERIAL_FILE_TOO_LARGE'
              ? t('memoMaterial.error.fileTooLarge', {
                  maxSizeMiB: Math.floor(res.maxSizeBytes / (1024 * 1024)),
                })
              : t('memoMaterial.error.pickFailed', { error: res.error });
          setOperationError(message);
        }
        return;
      }
      unownedPickedPath = res.filePath;
      if (!mountedRef.current) return;
      const previousPath = ownedImportPathRef.current;
      if (previousPath && previousPath !== res.filePath) {
        const deleted = await platform.material.deleteImport(previousPath);
        if (!deleted.ok) throw new Error(deleted.error);
        if (!mountedRef.current) return;
      }
      ownedImportPathRef.current = res.filePath;
      unownedPickedPath = null;
      setPickedSourcePath(res.filePath);
      if (!title) {
        const name = res.filePath.split(/[\\/]/).pop() ?? '';
        setTitle(name);
      }
    } catch (error) {
      setOperationError(
        t('memoMaterial.error.pickFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (unownedPickedPath) {
        const discarded = await platform.material.deleteImport(unownedPickedPath).catch(() => null);
        if (discarded && !discarded.ok) {
          console.warn('[material] failed to discard replacement picker import:', discarded.error);
        }
      }
      pickerInFlightRef.current = false;
      if (mountedRef.current) setPicking(false);
    }
  };

  const selectKind = async (nextKind: LibraryItemKind) => {
    if (nextKind === kind || submitting || pickerInFlightRef.current) return;
    try {
      setOperationError(null);
      await deleteOwnedImport();
      if (!mountedRef.current) return;
      setPickedSourcePath(null);
      setKind(nextKind);
    } catch (error) {
      setOperationError(
        t('memoMaterial.error.pickFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const cancel = async () => {
    if (submitting || pickerInFlightRef.current) return;
    try {
      setOperationError(null);
      await deleteOwnedImport();
      if (mountedRef.current) onCancel();
    } catch (error) {
      setOperationError(
        t('memoMaterial.error.pickFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const canSubmit = (() => {
    if (!title.trim() && kind !== 'text') return false;
    if (kind === 'url') return /^https?:\/\//i.test(url.trim());
    if (kind === 'image' || kind === 'pdf') return !!pickedSourcePath;
    if (kind === 'text') return true;
    return false;
  })();

  const submit = async () => {
    if (!canSubmit || submitting) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setOperationError(null);
    try {
      if (kind === 'url') {
        await deleteOwnedImport();
        const trimmedUrl = url.trim();
        // If the debounce hasn't fired yet, resolve once more synchronously so
        // the title / thumbnail are present at create time.
        let meta = urlMeta;
        if (!meta && /^https?:\/\//i.test(trimmedUrl) && canUseExternalContent()) {
          const res = await platform.material.resolveUrlMeta(trimmedUrl);
          if (res.ok) meta = { title: res.title, ogImage: res.ogImage, favicon: res.favicon };
        }
        await onCreate(
          {
            title: title.trim() || meta?.title || trimmedUrl,
            kind: 'url',
            externalUrl: trimmedUrl,
            previewImageUrl: meta?.ogImage ?? meta?.favicon ?? null,
          },
          relations,
        );
        onCancel();
        return;
      }
      if (kind === 'image' || kind === 'pdf') {
        if (!pickedSourcePath) return;
        await onCreate(
          {
            title: title.trim() || pickedSourcePath.split(/[\\/]/).pop() || t('common.untitled'),
            kind,
            sourcePath: pickedSourcePath,
          },
          relations,
        );
        if (ownedImportPathRef.current === pickedSourcePath) ownedImportPathRef.current = null;
        onCancel();
        return;
      }
      // text snippet — title + plain-text body. Body is editable inline on the
      // card after create; this is just the initial seed.
      await deleteOwnedImport();
      await onCreate(
        {
          title: title.trim() || t('common.untitled'),
          kind: 'text',
          bodyJson: body.trim() ? createPlainCommentDoc(body.trim()) : null,
        },
        relations,
      );
      onCancel();
    } catch (error) {
      console.warn('[material] create failed:', error);
      setOperationError(
        t('memoMaterial.error.createFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      submitInFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      } else {
        const abandonedPath = ownedImportPathRef.current;
        ownedImportPathRef.current = null;
        if (abandonedPath) {
          void platform.material
            .deleteImport(abandonedPath)
            .then((deleted) => {
              if (!deleted.ok) {
                console.warn('[material] failed to clean abandoned picker import:', deleted.error);
              }
            })
            .catch((error) => {
              console.warn('[material] failed to clean abandoned picker import:', error);
            });
        }
      }
    }
  };

  return (
    <DialogShell title={t('memoMaterial.dialog.newMaterial')} onCancel={() => void cancel()}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['url', 'image', 'pdf', 'text'] as LibraryItemKind[]).map((k) => (
          <FilterPill key={k} active={kind === k} onClick={() => void selectKind(k)}>
            {t(`memoMaterial.kind.${k}`, { defaultValue: k })}
          </FilterPill>
        ))}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting || picking}
        placeholder={t('memoMaterial.dialog.titlePlaceholder')}
        style={dialogInputStyle}
      />

      {kind === 'url' && (
        <>
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            style={{ ...dialogInputStyle, marginTop: 8 }}
          />
          {(resolving || urlMeta) && (
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 8px',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 3,
                background: 'hsl(var(--paper-deep) / 0.3)',
                minHeight: 56,
              }}
            >
              {urlMeta?.ogImage && canUseExternalContent() && (
                <img
                  src={urlMeta.ogImage}
                  alt=""
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 3,
                    background: 'hsl(var(--paper))',
                  }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    color: 'hsl(var(--ink-4))',
                    marginBottom: 2,
                  }}
                >
                  {resolving
                    ? t('memoMaterial.dialog.resolvingUrl')
                    : t('memoMaterial.dialog.urlInfo')}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12.5,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {urlMeta?.title ?? (resolving ? '…' : t('memoMaterial.dialog.noUrlTitle'))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {(kind === 'image' || kind === 'pdf') && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => pickFile(kind === 'image' ? 'image' : 'pdf')}
            disabled={submitting || picking}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '4px 10px',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 3,
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            {picking && <Loader2 className="control-spinner" aria-hidden />}
            {picking
              ? t('memoMaterial.dialog.openingPicker')
              : t('memoMaterial.dialog.chooseFile')}
          </button>
          {pickedSourcePath && (
            <span
              title={pickedSourcePath}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'hsl(var(--ink-4))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {pickedSourcePath}
            </span>
          )}
        </div>
      )}

      {submitting && (kind === 'image' || kind === 'pdf') && (
        <div className="material-import-feedback" role="status" aria-live="polite">
          <Loader2 className="control-spinner" aria-hidden />
          <div>
            <div className="material-import-feedback__title">
              {t(
                kind === 'image'
                  ? 'memoMaterial.dialog.importingImage'
                  : 'memoMaterial.dialog.importingPdf',
              )}
            </div>
            <div className="material-import-feedback__desc">
              {t('memoMaterial.dialog.importingFileDetail')}
            </div>
          </div>
        </div>
      )}

      {operationError && (
        <div className="material-import-feedback material-import-feedback--error" role="alert">
          {operationError}
        </div>
      )}

      {kind === 'text' && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('memoMaterial.card.snippetPlaceholder')}
          rows={5}
          style={{
            ...dialogInputStyle,
            marginTop: 8,
            resize: 'vertical',
            minHeight: 100,
            maxHeight: 240,
            fontFamily: 'var(--font-sans)',
          }}
        />
      )}

      <div
        style={{
          marginTop: 10,
          pointerEvents: submitting || picking ? 'none' : undefined,
          opacity: submitting || picking ? 0.58 : undefined,
        }}
      >
        <EntityRelationPicker
          selected={selectedSet}
          selectedChipMode="toggle"
          onAdd={(t) => setRelations((prev) => [...prev, t])}
          onRemove={(t) =>
            setRelations((prev) => prev.filter((r) => !(r.kind === t.kind && r.id === t.id)))
          }
        />
      </div>

      <DialogActions
        onCancel={() => void cancel()}
        onConfirm={() => void submit()}
        confirmDisabled={!canSubmit || submitting}
        confirmBusy={submitting}
        confirmLabel={
          submitting
            ? t(
                kind === 'image'
                  ? 'memoMaterial.dialog.importingImage'
                  : kind === 'pdf'
                    ? 'memoMaterial.dialog.importingPdf'
                    : 'memoMaterial.dialog.creating',
              )
            : undefined
        }
      />
    </DialogShell>
  );
}

function DialogShell({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <ModalRoot onClose={onCancel} ariaLabel={title}>
      <ModalCard width={520}>
        <ModalHeader title={title} />
        <ModalBody>{children}</ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}

function DialogActions({
  onCancel,
  onConfirm,
  confirmDisabled,
  confirmBusy = false,
  confirmLabel,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  confirmBusy?: boolean;
  confirmLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 6,
        marginTop: 12,
      }}
    >
      <Button size="sm" onClick={onCancel} disabled={confirmBusy}>
        {t('common.cancel')}
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={onConfirm}
        disabled={confirmDisabled}
        aria-busy={confirmBusy}
      >
        {confirmBusy && <Loader2 className="control-spinner" aria-hidden />}
        {confirmLabel ?? t('memoMaterial.dialog.create')}
      </Button>
    </div>
  );
}

const dialogInputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  padding: '6px 8px',
  border: '1px solid hsl(var(--rule))',
  borderRadius: 3,
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  outline: 'none',
};
