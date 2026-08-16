import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LibraryItem, LibraryItemPatch } from '../../domain/library-item';
import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { canUseExternalContent } from '../../lib/config';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import {
  libraryItemSubtitle,
  useStoredLibraryItemVariant,
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
  onUpdate: (updates: LibraryItemPatch) => void;
  onDelete: () => void;
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
  const assetDisplay = useStoredLibraryItemVariant(
    material,
    'display',
    material.kind === 'image' && imageExpanded,
  );
  const imageSrc = material.kind === 'image' ? assetDisplay.fileUrl : null;
  const canExpandImage = material.kind === 'image';
  const isImageExpanded = material.kind === 'image' && imageExpanded && !!imageSrc;
  const isTextExpanded = isTextSnippet && textExpanded;
  const textBody = material.kind === 'text' ? extractTextFromCommentBody(material.bodyJson) : '';
  const handleOpenInSystem = useCallback(() => onOpenInSystem(), [onOpenInSystem]);
  const handleOpenInApp = useCallback(() => onOpenInApp(), [onOpenInApp]);

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
          // The relation target picker is part of the card's authored
          // content, not an inset scroll region. Let the card grow around it
          // while open; the surrounding library panel remains the sole
          // vertical scroll owner.
          maxHeight: isTextExpanded || pickerOpen ? 'none' : 320,
          overflow: isTextExpanded || pickerOpen ? 'visible' : 'hidden',
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
              {t('memoMaterial.menu.openInSystem')}
            </button>
          )}
        </div>

        {!isImageExpanded && !isTextExpanded && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 0 }}>
            <LibraryItemThumbnail material={material} onClick={handleOpenInApp} />
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
              {subtitle && !isTextSnippet && (
                <div
                  title={material.kind === 'url' ? material.externalUrl : undefined}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'hsl(var(--ink-4))',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {subtitle}
                  </span>
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
                color: textBody ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
                fontStyle: textBody ? 'normal' : 'italic',
                lineHeight: 1.5,
                cursor: 'text',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {textBody || t('memoMaterial.card.addSnippetBody')}
            </div>
          </div>
        )}

        {isImageExpanded && (
          <button
            type="button"
            onClick={handleOpenInApp}
            title={t('memoMaterial.card.fullscreenImage')}
            style={{
              marginTop: 8,
              padding: 0,
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              background: 'hsl(var(--paper-deep) / 0.35)',
              cursor: 'zoom-in',
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
              color: textBody ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
              fontStyle: textBody ? 'normal' : 'italic',
              lineHeight: 1.5,
              cursor: 'text',
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
            {textBody || t('memoMaterial.card.addSnippetBody')}
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
  onClick,
}: {
  material: LibraryItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const size = 64;
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const externalContentEnabled = canUseExternalContent();
  const assetThumbnail = useStoredLibraryItemVariant(
    material,
    'thumbnail',
    material.kind === 'image' || material.kind === 'pdf',
  );
  const currentImageKey = `${material.id}:${material.assetId ?? ''}:${assetThumbnail.fileUrl ?? material.previewImageUrl ?? material.externalUrl ?? ''}`;
  const errored = errorKey === currentImageKey;
  let src: string | null = null;
  if (!errored) {
    if (material.kind === 'image' || material.kind === 'pdf') {
      src = assetThumbnail.fileUrl;
    } else if (material.kind === 'url' && externalContentEnabled) {
      src = material.previewImageUrl;
    }
  }
  if (!src) {
    if (material.kind === 'text') return null;
    return (
      <div
        onClick={onClick}
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
          cursor: 'pointer',
        }}
        title={
          material.kind === 'pdf'
            ? t('memoMaterial.preview.generating')
            : t('memoMaterial.preview.open')
        }
      >
        {material.kind === 'pdf' ? (
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
      onClick={onClick}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        border: '1px solid hsl(var(--rule))',
        borderRadius: 3,
        background: 'hsl(var(--paper-deep))',
        cursor: 'pointer',
        padding: 0,
        overflow: 'hidden',
        position: 'relative',
      }}
      title={t('memoMaterial.preview.open')}
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
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage text snippet popover — first click on a text snippet body opens
// this compact floating editor; an explicit 全屏 ↗ control escalates to the
// fullscreen preview. Mirrors the StoryGraphView NodeCardPopover default/upgrade
// staging so quick reads don't force a fullscreen jump.
