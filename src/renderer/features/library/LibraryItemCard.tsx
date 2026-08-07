import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LibraryItem } from '../../domain/library-item';
import type { LibraryItemUploadState } from '../../store/data-store';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { useDataStore } from '../../store/data-store';
import { platform } from '../../platform';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import {
  libraryItemImageSrc,
  libraryItemSubtitle,
  useCachedLibraryItemVariant,
} from './library-item-media';

type LibraryItemContextMenuAction = 'addRelation' | 'openInSystem' | 'delete';

function LibraryItemContextMenuItem({
  glyph,
  label,
  action,
  onAction,
  variant = 'default',
}: {
  glyph: string;
  label: string;
  action: LibraryItemContextMenuAction;
  onAction: (action: LibraryItemContextMenuAction) => void;
  variant?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-surface__item btl-cmenu__item${
        variant === 'danger' ? ' menu-surface__item--danger is-danger' : ''
      }`}
      onClick={() => onAction(action)}
    >
      <span className="btl-cmenu__glyph" aria-hidden>
        {glyph}
      </span>
      <span className="btl-cmenu__label">{label}</span>
    </button>
  );
}

function LibraryItemContextMenu({
  material,
  relationCount,
  x,
  y,
  onOpenInSystem,
  onAddRelation,
  onDelete,
  onClose,
}: {
  material: LibraryItem;
  relationCount: number;
  x: number;
  y: number;
  onOpenInSystem: () => void;
  onAddRelation: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const isTextSnippet = material.kind === 'text';
  const kindLabel = t(`memoMaterial.kind.${material.kind}`, { defaultValue: material.kind });
  const subtitle = libraryItemSubtitle(material);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const padding = 8;
    let left = x;
    let top = y;
    if (left + rect.width + padding > window.innerWidth) {
      left = Math.max(padding, window.innerWidth - rect.width - padding);
    }
    if (top + rect.height + padding > window.innerHeight) {
      top = Math.max(padding, window.innerHeight - rect.height - padding);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDocPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('contextmenu', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('contextmenu', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [onClose]);

  const handleAction = (action: LibraryItemContextMenuAction) => {
    if (action === 'addRelation') onAddRelation();
    if (action === 'openInSystem') onOpenInSystem();
    if (action === 'delete') onDelete();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="menu-surface menu-surface--rich menu-surface--wide btl-cmenu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top, zIndex: 'var(--z-context-menu)' }}
    >
      <div className="btl-cmenu__head">
        <div className="btl-cmenu__title">{material.title || subtitle || t('common.untitled')}</div>
        <div className="btl-cmenu__summary">{t('memoMaterial.menu.type', { type: kindLabel })}</div>
        <div className="btl-cmenu__summary">
          {relationCount > 0
            ? t('memoMaterial.menu.relationCount', { count: relationCount })
            : t('memoMaterial.menu.noRelations')}
        </div>
      </div>

      <div className="btl-cmenu__group">
        <LibraryItemContextMenuItem
          glyph="＋"
          label={t('memoMaterial.menu.addRelation')}
          action="addRelation"
          onAction={handleAction}
        />
      </div>

      {!isTextSnippet && (
        <div className="btl-cmenu__group">
          <LibraryItemContextMenuItem
            glyph="↗"
            label={t('memoMaterial.menu.openInSystem')}
            action="openInSystem"
            onAction={handleAction}
          />
        </div>
      )}

      <div className="btl-cmenu__group">
        <LibraryItemContextMenuItem
          glyph="×"
          label={t('memoMaterial.menu.deleteMaterial')}
          action="delete"
          onAction={handleAction}
          variant="danger"
        />
      </div>
    </div>,
    document.body,
  );
}


export function LibraryItemCard({
  material,
  relations,
  editing,
  showRelations = true,
  onSetEditing,
  onOpenInSystem,
  onOpenInApp,
  onUpdate,
  onDelete,
  onRetryUpload,
  onAddRelation,
  onRemoveRelation,
  defaultExpanded = false,
}: {
  material: LibraryItem;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  editing: boolean;
  /** When false, hide the relation chips/picker entirely even if relations
   *  exist. Controlled from the panel toolbar's link toggle. */
  showRelations?: boolean;
  onSetEditing: (on: boolean) => void;
  onOpenInSystem: () => void;
  onOpenInApp: () => void;
  onUpdate: (updates: Partial<LibraryItem>) => void;
  onDelete: () => void;
  onRetryUpload: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
  /** Pre-expand image / text bodies on mount. Used by the global super view
   *  where there's enough vertical room to show full bodies up front. */
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(material.title);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(defaultExpanded);
  const [textExpanded, setTextExpanded] = useState(defaultExpanded);
  const uploadState = useDataStore((s) => s.libraryItemUploadStates[material.id] ?? null);
  const uploadBusy = uploadState?.state === 'uploading';
  const uploadFailed = uploadState?.state === 'failed';
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  // Picker is mounted when: user explicitly opened it from the context menu,
  // OR relations exist AND the panel-wide toggle is on. Collapsing the toggle
  // hides existing relations on every card; opening via context menu still
  // works even when collapsed (lasts until the user closes the picker).
  const showPicker = pickerOpen || (showRelations && selectedSet.size > 0);
  const accent = 'hsl(var(--story-4))';
  const kindLabel = t(`memoMaterial.kind.${material.kind}`, { defaultValue: material.kind });
  const subtitle = libraryItemSubtitle(material);
  const isTextSnippet = material.kind === 'text';
  const r2Display = useCachedLibraryItemVariant(
    material,
    'display',
    material.source === 'r2' && material.kind === 'image' && imageExpanded,
  );
  const imageSrc =
    material.source === 'r2' && material.kind === 'image'
      ? r2Display.fileUrl
      : libraryItemImageSrc(material);
  const canExpandImage =
    !uploadBusy &&
    material.kind === 'image' &&
    (!!imageSrc || (material.source === 'r2' && !!material.assetId));
  const isImageExpanded = !uploadBusy && material.kind === 'image' && imageExpanded && !!imageSrc;
  const isTextExpanded = isTextSnippet && textExpanded;
  const handleOpenInSystem = useCallback(() => {
    if (uploadBusy) return;
    onOpenInSystem();
  }, [onOpenInSystem, uploadBusy]);
  const handleOpenInApp = useCallback(() => {
    if (uploadBusy) return;
    onOpenInApp();
  }, [onOpenInApp, uploadBusy]);
  // Auto-generate PDF thumbnails the first time a card renders. macOS Quick
  // Look (via nativeImage.createThumbnailFromPath) renders the first page;
  // cache the resulting data URL on the material so we don't redo it.
  useEffect(() => {
    if (material.kind !== 'pdf') return;
    if (material.thumbnailUri) return;
    if (!material.localPath) return;
    let cancelled = false;
    void platform.material.thumbnail(material.localPath, 192).then((res) => {
      if (cancelled || !res.ok) return;
      onUpdate({ thumbnailUri: res.dataUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [material.id, material.kind, material.localPath, material.thumbnailUri, onUpdate]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  return (
    <>
      <div
        className="workspace-list-row"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onContextMenu={openContextMenu}
        style={{
          padding: '8px 10px',
          maxHeight: isTextExpanded ? 'none' : 320,
          overflow: isTextExpanded ? 'visible' : 'hidden',
          display: 'flex',
          flexDirection: 'column',
          // Prevents the flex-column scroll parent from shrinking each card
          // and clipping the relation picker.
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 3,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'hsl(var(--ink-4))',
            flexShrink: 0,
            minHeight: 18,
          }}
        >
          <span style={{ color: accent }}>{kindLabel}</span>
          <span style={{ flex: 1 }} />
          {canExpandImage && (
            <button
              onClick={() => setImageExpanded((v) => !v)}
              title={
                imageExpanded
                  ? t('memoMaterial.card.collapseImage')
                  : t('memoMaterial.card.expandImage')
              }
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {imageExpanded ? t('memoMaterial.card.collapse') : t('memoMaterial.card.expand')}
            </button>
          )}
          {isTextSnippet && (
            <button
              onClick={() => setTextExpanded((v) => !v)}
              title={
                textExpanded
                  ? t('memoMaterial.card.collapseSnippet')
                  : t('memoMaterial.card.expandSnippet')
              }
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {textExpanded ? t('memoMaterial.card.collapse') : t('memoMaterial.card.expand')}
            </button>
          )}
          {!isTextSnippet && (
            <button
              onClick={handleOpenInSystem}
              title={t('memoMaterial.menu.openInSystem')}
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              disabled={uploadBusy}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: uploadBusy ? 'default' : 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {t('memoMaterial.menu.openInSystem')}
            </button>
          )}
        </div>

        {!isImageExpanded && !isTextExpanded && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 0 }}>
            <LibraryItemThumbnail
              material={material}
              uploadState={uploadState}
              onClick={handleOpenInApp}
            />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {editing ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft !== material.title) onUpdate({ title: draft });
                    onSetEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === 'Escape') {
                      setDraft(material.title);
                      onSetEditing(false);
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13.5,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.35,
                    padding: '2px 4px',
                    border: '1px solid hsl(var(--rule))',
                    borderRadius: 3,
                    background: 'hsl(var(--paper))',
                    outline: 'none',
                  }}
                />
              ) : (
                <div
                  onClick={() => {
                    setDraft(material.title);
                    onSetEditing(true);
                  }}
                  title={material.title || subtitle}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.35,
                    cursor: 'text',
                    minHeight: 18,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {material.title || (
                    <span style={{ color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>
                      {subtitle || t('common.untitled')}
                    </span>
                  )}
                </div>
              )}
              {(uploadState || (subtitle && !isTextSnippet)) && (
                <div
                  title={uploadFailed ? uploadState.error : material.uri}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: uploadFailed ? 'hsl(var(--danger, var(--accent)))' : 'hsl(var(--ink-4))',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {uploadBusy
                      ? t('memoMaterial.upload.uploading')
                      : uploadFailed
                        ? t('memoMaterial.upload.failed')
                        : subtitle}
                  </span>
                  {uploadFailed && (
                    <button
                      type="button"
                      onClick={onRetryUpload}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        color: 'inherit',
                        font: 'inherit',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {t('common.retry')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {isTextExpanded && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft !== material.title) onUpdate({ title: draft });
                  onSetEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setDraft(material.title);
                    onSetEditing(false);
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13.5,
                  color: 'hsl(var(--ink-1))',
                  lineHeight: 1.35,
                  padding: '2px 4px',
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 3,
                  background: 'hsl(var(--paper))',
                  outline: 'none',
                }}
              />
            ) : (
              <div
                onClick={() => {
                  setDraft(material.title);
                  onSetEditing(true);
                }}
                title={material.title || subtitle}
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: 'hsl(var(--ink-1))',
                  lineHeight: 1.35,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  cursor: 'text',
                  minHeight: 18,
                }}
              >
                {material.title || (
                  <span style={{ color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>
                    {subtitle || t('common.untitled')}
                  </span>
                )}
              </div>
            )}
            <div
              onClick={handleOpenInApp}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                color: material.bodyJson ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
                fontStyle: material.bodyJson ? 'normal' : 'italic',
                lineHeight: 1.5,
                cursor: uploadBusy ? 'default' : 'text',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {material.bodyJson || t('memoMaterial.card.addSnippetBody')}
            </div>
          </div>
        )}

        {isImageExpanded && (
          <button
            type="button"
            onClick={handleOpenInApp}
            title={t('memoMaterial.card.fullscreenImage')}
            disabled={uploadBusy}
            style={{
              marginTop: 8,
              padding: 0,
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              background: 'hsl(var(--paper-deep) / 0.35)',
              cursor: uploadBusy ? 'default' : 'zoom-in',
              overflow: 'hidden',
              width: '100%',
              maxHeight: 220,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <img
              src={imageSrc}
              alt=""
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                maxHeight: 220,
                objectFit: 'contain',
              }}
            />
          </button>
        )}

        {isTextSnippet && !isTextExpanded && (
          <div
            onClick={handleOpenInApp}
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              color: material.bodyJson ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
              fontStyle: material.bodyJson ? 'normal' : 'italic',
              lineHeight: 1.5,
              cursor: uploadBusy ? 'default' : 'text',
              maxHeight: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 7,
              WebkitBoxOrient: 'vertical',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {material.bodyJson || t('memoMaterial.card.addSnippetBody')}
          </div>
        )}

        {showPicker && (
          <div style={{ marginTop: 6, flexShrink: 0 }}>
            <EntityRelationPicker
              selected={selectedSet}
              onAdd={onAddRelation}
              onRemove={onRemoveRelation}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            />
          </div>
        )}
      </div>
      {contextMenu && (
        <LibraryItemContextMenu
          material={material}
          relationCount={relations.length}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpenInSystem={handleOpenInSystem}
          onAddRelation={() => setPickerOpen(true)}
          onDelete={onDelete}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail — inline preview tile for image / pdf / url libraryItems.

function LibraryItemThumbnail({
  material,
  uploadState,
  onClick,
}: {
  material: LibraryItem;
  uploadState: LibraryItemUploadState | null;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const size = 64;
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const uploadBusy = uploadState?.state === 'uploading';
  const r2Thumbnail = useCachedLibraryItemVariant(
    material,
    'thumbnail',
    material.source === 'r2' && (material.kind === 'image' || material.kind === 'pdf'),
  );
  const currentImageKey = `${material.id}:${material.assetId ?? ''}:${r2Thumbnail.fileUrl ?? material.thumbnailUri ?? material.uri}`;
  const errored = errorKey === currentImageKey;
  let src: string | null = null;
  if (!errored) {
    if (material.source === 'r2' && (material.kind === 'image' || material.kind === 'pdf')) {
      src = r2Thumbnail.fileUrl;
    } else if (material.kind === 'image') {
      // Tauri exposes app-owned imports through its scoped asset protocol.
      // Arbitrary legacy paths intentionally fail closed and can still be
      // opened through the native command or re-imported into app storage.
      src = libraryItemImageSrc(material);
    } else if (material.kind === 'pdf' && material.thumbnailUri) {
      src = material.thumbnailUri;
    } else if (material.kind === 'url' && material.thumbnailUri) {
      src = material.thumbnailUri;
    }
  }
  if (!src) {
    if (
      material.kind === 'text' ||
      (material.kind === 'pdf' && !material.localPath && material.source !== 'r2')
    ) {
      return null;
    }
    return (
      <div
        onClick={uploadBusy ? undefined : onClick}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: 3,
          background: 'hsl(var(--paper-deep) / 0.4)',
          border: '1px dashed hsl(var(--rule))',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
          cursor: uploadBusy ? 'default' : 'pointer',
        }}
        title={
          material.kind === 'pdf'
            ? t('memoMaterial.preview.generating')
            : t('memoMaterial.preview.open')
        }
      >
        {uploadBusy ? (
          <Loader2
            size={15}
            style={{ animation: 'drift-spin 900ms linear infinite' }}
            aria-hidden
          />
        ) : material.kind === 'pdf' ? (
          '...'
        ) : (
          t(`memoMaterial.kind.${material.kind}`, { defaultValue: material.kind })
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={uploadBusy ? undefined : onClick}
      disabled={uploadBusy}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        border: '1px solid hsl(var(--rule))',
        borderRadius: 3,
        background: 'hsl(var(--paper-deep))',
        cursor: uploadBusy ? 'default' : 'pointer',
        padding: 0,
        overflow: 'hidden',
        position: 'relative',
      }}
      title={uploadBusy ? t('memoMaterial.upload.uploading') : t('memoMaterial.preview.open')}
    >
      <img
        src={src}
        alt=""
        onError={() => setErrorKey(currentImageKey)}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />
      {uploadBusy && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'hsl(var(--paper) / 0.64)',
            color: 'hsl(var(--ink-3))',
          }}
        >
          <Loader2
            size={15}
            style={{ animation: 'drift-spin 900ms linear infinite' }}
            aria-hidden
          />
        </span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage text snippet popover — first click on a text snippet body opens
// this compact floating editor; an explicit 全屏 ↗ control escalates to the
// fullscreen preview. Mirrors the StoryGraphView NodeCardPopover default/upgrade
// staging so quick reads don't force a fullscreen jump.
