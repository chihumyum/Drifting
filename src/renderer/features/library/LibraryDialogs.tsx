import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPlainCommentDoc } from '../../domain/comment';
import type { LibraryItemKind } from '../../domain/library-item';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { platform } from '../../platform';
import type { CreateLibraryItemInput } from '../../usecase/useLibraryItem';
import { type FocusedEntity } from './LibraryPanel';
import { GlassSlider } from '../../components/ui/GlassSlider';
import { useEscapeToClose } from './library-item-media';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { getPlatformRuntime } from '../../platform/runtime';

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
  const glass = !getPlatformRuntime().isMobileShell;
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
      <GlassField glass={glass}>
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
          style={glass ? undefined : dialogTextareaStyle}
        />
      </GlassField>
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
  const glass = !getPlatformRuntime().isMobileShell;
  const [kind, setKind] = useState<LibraryItemKind>('text');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pickedSourcePath, setPickedSourcePath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
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
      <div style={{ marginBottom: 10 }}>
        <GlassSlider
          ariaLabel={t('memoMaterial.dialog.newMaterial')}
          value={kind}
          onChange={(k) => void selectKind(k)}
          options={(['text', 'image', 'pdf'] as const).map((k) => ({
            value: k,
            label: t(`memoMaterial.kind.${k}`, { defaultValue: k }),
          }))}
        />
      </div>

      <GlassField glass={glass}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting || picking}
          placeholder={t('memoMaterial.dialog.titlePlaceholder')}
          style={glass ? undefined : dialogInputStyle}
        />
      </GlassField>

      {(kind === 'image' || kind === 'pdf') && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          {glass ? (
            // Desktop: the secondary button (the resting line of glass).
            <Button size="sm" onClick={() => pickFile(kind === 'image' ? 'image' : 'pdf')} disabled={submitting || picking}>
              {picking && <BrushIcon name="loader" size={13} className="control-spinner" />}
              {picking
                ? t('memoMaterial.dialog.openingPicker')
                : t('memoMaterial.dialog.chooseFile')}
            </Button>
          ) : (
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
            {picking && <BrushIcon name="loader" size={13} className="control-spinner" />}
            {picking
              ? t('memoMaterial.dialog.openingPicker')
              : t('memoMaterial.dialog.chooseFile')}
          </button>
          )}
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
        <div className={`material-import-feedback${glass ? ' material-import-feedback--quiet' : ''}`} role="status" aria-live="polite">
          <BrushIcon name="loader" size={13} className="control-spinner" />
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
        <div
          className={`material-import-feedback material-import-feedback--error${glass ? ' material-import-feedback--quiet' : ''}`}
          role="alert"
        >
          {glass && <BrushIcon name="status-warning" size={13} />}
          {operationError}
        </div>
      )}

      {kind === 'text' && (
        <GlassField glass={glass}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('memoMaterial.card.snippetPlaceholder')}
            rows={5}
            style={
              glass
                ? { minHeight: 100, maxHeight: 240 }
                : {
                    ...dialogInputStyle,
                    marginTop: 8,
                    resize: 'vertical',
                    minHeight: 100,
                    maxHeight: 240,
                    fontFamily: 'var(--font-sans)',
                  }
            }
          />
        </GlassField>
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
  // Desktop: cancel is a text button beside the one primary glass button.
  const glass = !getPlatformRuntime().isMobileShell;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 6,
        marginTop: 12,
      }}
    >
      <Button size="sm" variant={glass ? 'ghost' : 'default'} onClick={onCancel} disabled={confirmBusy}>
        {t('common.cancel')}
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={onConfirm}
        disabled={confirmDisabled}
        aria-busy={confirmBusy}
      >
        {confirmBusy && <BrushIcon name="loader" size={13} className="control-spinner" />}
        {confirmLabel ?? t('memoMaterial.dialog.create')}
      </Button>
    </div>
  );
}

/** Desktop: a paper-coloured field with the resting line of glass, still while it holds the caret. */
function GlassField({ glass, children }: { glass: boolean; children: React.ReactNode }) {
  if (!glass) return <>{children}</>;
  return <span className="material-field library-dialog__field glass glass--rest glass--field">{children}</span>;
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
