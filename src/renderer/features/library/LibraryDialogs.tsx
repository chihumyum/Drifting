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
import { ImageCodecUnavailableError } from '../../services/local-project-asset.service';
import { WINDOWS_IMAGE_CODEC_STORE_URL } from '../../lib/windows-image-codecs';

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
      <GlassField area>
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

export function ComposeLibraryItemDialog({
  focused,
  initialKind = 'text',
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  /** The type already chosen elsewhere (Project Home's 图片… / PDF…). */
  initialKind?: LibraryItemKind;
  onCancel: () => void;
  onCreate: (input: CreateLibraryItemInput, relations: RelationTarget[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LibraryItemKind>(initialKind);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pickedSourcePath, setPickedSourcePath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  // Windows without the Store codec for this image: where to get it.
  const [codecStoreUrl, setCodecStoreUrl] = useState<string | null>(null);
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
    setCodecStoreUrl(null);
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
      if (error instanceof ImageCodecUnavailableError && error.codec && getPlatformRuntime().isWindowsDesktop) {
        setOperationError(t('memoMaterial.error.codecUnavailable', { format: error.codec.toUpperCase() }));
        setCodecStoreUrl(WINDOWS_IMAGE_CODEC_STORE_URL[error.codec]);
        return;
      }
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

      <GlassField>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting || picking}
          placeholder={t('memoMaterial.dialog.titlePlaceholder')}
        />
      </GlassField>

      {(kind === 'image' || kind === 'pdf') && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button size="sm" onClick={() => pickFile(kind === 'image' ? 'image' : 'pdf')} disabled={submitting || picking}>
            {picking && <BrushIcon name="loader" size={13} className="control-spinner" />}
            {picking
              ? t('memoMaterial.dialog.openingPicker')
              : t('memoMaterial.dialog.chooseFile')}
          </Button>
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
        <div className="material-import-feedback material-import-feedback--quiet" role="status" aria-live="polite">
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
          className="material-import-feedback material-import-feedback--error material-import-feedback--quiet"
          role="alert"
        >
          <BrushIcon name="status-warning" size={13} />
          {operationError}
          {codecStoreUrl && (
            <Button
              variant="ghost"
              onClick={() => {
                void platform.material.openExternal(codecStoreUrl);
              }}
            >
              {t('memoMaterial.error.codecStore')}
            </Button>
          )}
        </div>
      )}

      {kind === 'text' && (
        <GlassField area>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('memoMaterial.card.snippetPlaceholder')}
            rows={5}
            style={{ minHeight: 100, maxHeight: 240 }}
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
  // Cancel is a text button beside the one primary glass button.
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 6,
        marginTop: 12,
      }}
    >
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={confirmBusy}>
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

/** The shared field (components.md) — a paper slip with the resting line of glass. */
function GlassField({ area = false, children }: { area?: boolean; children: React.ReactNode }) {
  return (
    <label className={`ui-field${area ? ' ui-field--area' : ''} library-dialog__field glass glass--rest glass--field${area ? '' : ' glass--small'}`}>
      {children}
    </label>
  );
}
