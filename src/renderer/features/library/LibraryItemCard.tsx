import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LibraryItem, LibraryItemPatch } from '../../domain/library-item';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { NoteExcerpt } from './NoteExcerpt';
// The mobile ⋯ menu reuses the `.btl-cmenu` rich-menu rules, which the
// workspace no longer loads through a mounted Bottom Timeline.
import '../../../styles/bottom-timeline.css';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { HoverCardHeading, HoverCardShell, type HoverActionGroup } from '../../components/ui/HoverCard';
import { useHoverPreview } from '../entities/hover/entity-hover-card-model';
import { KindMark } from '../../components/ui/KindMark';
import { SandFrame } from '../../components/ui/SandFrame';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import {
  libraryItemSubtitle,
  useStoredLibraryItemVariant,
} from './library-item-media';

const MOBILE_MENU_GLYPHS: Record<string, string> = {
  addRelation: '＋',
  moveToFolder: '→',
  openInSystem: '↗',
  delete: '×',
};

/**
 * The material's actions for a touch screen, which has no hover card: a
 * menu under the ⋯ button with the card's heading and the same actions.
 */
function LibraryItemMobileMenu({
  title,
  details,
  actions,
  mobileActions,
  x,
  y,
  onClose,
}: {
  title: string;
  details: string[];
  actions: HoverActionGroup[];
  mobileActions: boolean;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

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
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="menu-surface menu-surface--rich menu-surface--wide btl-cmenu"
      data-library-mobile-actions={mobileActions ? 'true' : undefined}
      onClick={(e) => e.stopPropagation()}
      style={{ left: pos.left, top: pos.top, zIndex: 'var(--z-context-menu)' }}
    >
      <div className="btl-cmenu__head">
        <div className="btl-cmenu__title">{title}</div>
        {details.map((detail) => (
          <div key={detail} className="btl-cmenu__summary">{detail}</div>
        ))}
      </div>
      {actions.map((group) => (
        <div key={group.key} className="btl-cmenu__group">
          {group.actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={`menu-surface__item btl-cmenu__item${
                action.danger ? ' menu-surface__item--danger is-danger' : ''
              }`}
              onClick={() => {
                action.onSelect?.();
                onClose();
              }}
            >
              <span className="btl-cmenu__glyph" aria-hidden>
                {MOBILE_MENU_GLYPHS[action.key]}
              </span>
              <span className="btl-cmenu__label">{action.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}


export function LibraryItemCard({
  material,
  relations,
  editing,
  showRelations = true,
  mobileActions = false,
  onSetEditing,
  onOpenInSystem,
  onOpenInApp,
  onPin,
  active = false,
  folderPath,
  onMoveToFolder,
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
  /** Exposes an ordinary tap target for actions that desktop keeps in the hover card. */
  mobileActions?: boolean;
  onSetEditing: (on: boolean) => void;
  onOpenInSystem: () => void;
  onOpenInApp: () => void;
  /** Double-click: open the material as a pinned (non-preview) tab. */
  onPin?: () => void;
  /** The material shown in the active workspace tab. */
  active?: boolean;
  /** "A / B" when the material sits in a folder. */
  folderPath?: string;
  onMoveToFolder?: () => void;
  onUpdate: (updates: LibraryItemPatch) => void;
  onDelete: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
  /** Pre-expand image / text bodies on mount. Used by the global super view
   *  where there's enough vertical room to show full bodies up front. */
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(material.title);
  const [mobileMenu, setMobileMenu] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(defaultExpanded);
  const [textExpanded, setTextExpanded] = useState(defaultExpanded);
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  // Picker is mounted when: user explicitly opened it from the card's actions,
  // OR relations exist AND the panel-wide toggle is on. Collapsing the toggle
  // hides existing relations on every card; opening via the actions still
  // works even when collapsed (lasts until the user closes the picker).
  const showPicker = pickerOpen || (showRelations && selectedSet.size > 0);
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
  const handleOpenInSystem = useCallback(() => onOpenInSystem(), [onOpenInSystem]);
  const handleOpenInApp = useCallback(() => onOpenInApp(), [onOpenInApp]);

  // Resting the pointer on the card shows its heading and actions (there is
  // no right-click menu); a touch screen gets them from the ⋯ button instead.
  const { preview: hoverPreview, onEnter: hoverEnter, onLeave: hoverLeave, dismiss: hoverDismiss, card: hoverCard } =
    useHoverPreview<null>();
  const hoverEnabled = !mobileActions && !editing && !pickerOpen;
  useEffect(() => {
    if (!hoverEnabled) hoverDismiss();
  }, [hoverEnabled, hoverDismiss]);
  const cardTitle = material.title || subtitle || t('common.untitled');
  const cardDetails = [
    t('memoMaterial.menu.type', { type: kindLabel }),
    relations.length > 0
      ? t('memoMaterial.menu.relationCount', { count: relations.length })
      : t('memoMaterial.menu.noRelations'),
  ];
  const actions: HoverActionGroup[] = [
    {
      key: 'organize',
      actions: [
        { key: 'addRelation', label: t('memoMaterial.menu.addRelation'), icon: { brush: 'knot-links' as const }, onSelect: () => setPickerOpen(true) },
        ...(onMoveToFolder
          ? [{ key: 'moveToFolder', label: t('editorTopBar.menu.moveMaterialToFolder'), icon: { brush: 'folder' as const }, onSelect: onMoveToFolder }]
          : []),
      ],
    },
    {
      key: 'system',
      actions: isTextSnippet
        ? []
        : [{ key: 'openInSystem', label: t('memoMaterial.menu.openInSystem'), icon: { brush: 'arrow-out' as const }, onSelect: handleOpenInSystem }],
    },
    {
      key: 'delete',
      actions: [{ key: 'delete', label: t('memoMaterial.menu.deleteMaterial'), icon: { brush: 'trash' as const }, danger: true, onSelect: onDelete }],
    },
  ].filter((group) => group.actions.length > 0);

  const closeMobileMenu = useCallback(() => setMobileMenu(null), []);

  const openMobileActionMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMobileMenu({ x: rect.right, y: rect.bottom + 4 });
  }, []);

  // A material is a sand cell (the upright slip, a ring of flowing glass
  // under the pointer, a frame drawn round the one open in the active tab).
  const rowEvents = {
    onMouseEnter: (event: React.MouseEvent<HTMLDivElement>) => {
      if (hoverEnabled) hoverEnter(null, event.currentTarget);
    },
    onMouseLeave: hoverLeave,
    onPointerDownCapture: hoverDismiss,
    onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!onPin || target?.closest('input, textarea, button, [contenteditable="true"]')) return;
      onPin();
    },
  };
  const startEditing = () => {
    setDraft(material.title);
    onSetEditing(true);
  };
  const titleInput = (
    <input
      autoFocus
      value={draft}
      aria-label={t('common.edit')}
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
    />
  );
  const expanded = canExpandImage ? imageExpanded : textExpanded;
  const expandLabel = canExpandImage
    ? imageExpanded ? t('memoMaterial.card.collapseImage') : t('memoMaterial.card.expandImage')
    : textExpanded ? t('memoMaterial.card.collapseSnippet') : t('memoMaterial.card.expandSnippet');
  const glassCard = (
    <div
      className={[
        'library-item-card',
        'sand-cell',
        active ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--cell-c': 'hsl(var(--ink-3))' } as CSSProperties}
      aria-current={active ? 'page' : undefined}
      {...rowEvents}
    >
      <div className="library-item-card__head">
        {!isImageExpanded && <LibraryItemThumbnail material={material} onClick={handleOpenInApp} />}
        <div className="library-item-card__text">
          <div className="library-item-card__title-row">
            <KindMark kind="material" color="hsl(var(--ink-3))" />
            {editing ? (
              <span className="library-item-card__title-field glass glass--rest glass--field glass--small">{titleInput}</span>
            ) : (
              <span
                className="library-item-card__title"
                onClick={startEditing}
                title={material.title || subtitle}
                role="button"
                tabIndex={0}
                aria-label={`${t('common.edit')} ${material.title || subtitle || t('common.untitled')}`}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  startEditing();
                }}
              >
                {material.title || (
                  <span className="library-item-card__title--untitled">{subtitle || t('common.untitled')}</span>
                )}
              </span>
            )}
            <span className="library-item-card__actions">
              {(canExpandImage || isTextSnippet) && (
                <GhostIconButton
                  size="sm"
                  icon={
                    <BrushIcon
                      name="chevron-right"
                      size={12}
                      className={expanded ? 'library-item-card__chevron--open' : undefined}
                    />
                  }
                  title={expandLabel}
                  aria-label={expandLabel}
                  aria-expanded={expanded}
                  onClick={() => (canExpandImage ? setImageExpanded((v) => !v) : setTextExpanded((v) => !v))}
                />
              )}
              {!isTextSnippet && (
                <GhostIconButton
                  size="sm"
                  icon={<BrushIcon name="arrow-out" size={12} />}
                  title={t('memoMaterial.menu.openInSystem')}
                  aria-label={t('memoMaterial.menu.openInSystem')}
                  onClick={handleOpenInSystem}
                />
              )}
              {mobileActions && (
                <GhostIconButton
                  size="sm"
                  className="library-item-card__mobile-menu"
                  icon={<BrushIcon name="more" size={12} />}
                  title={t('common.more')}
                  aria-label={t('common.more')}
                  onClick={openMobileActionMenu}
                />
              )}
            </span>
          </div>
          <div className="library-item-card__meta">
            {[kindLabel, folderPath, isTextSnippet ? null : subtitle].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      {isImageExpanded && (
        <button
          type="button"
          className="library-item-card__image"
          onClick={handleOpenInApp}
          title={t('memoMaterial.card.fullscreenImage')}
        >
          <img src={imageSrc} alt="" />
        </button>
      )}
      {isTextSnippet && (
        <div className="library-item-card__excerpt">
          <NoteExcerpt
            bodyJson={material.kind === 'text' ? material.bodyJson : null}
            emptyLabel={t('memoMaterial.card.addSnippetBody')}
            clamp={!isTextExpanded}
            onOpen={handleOpenInApp}
          />
        </div>
      )}
      {showPicker && (
        <div className="library-item-card__extra">
          <EntityRelationPicker
            selected={selectedSet}
            onAdd={onAddRelation}
            onRemove={onRemoveRelation}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
        </div>
      )}
      <i className="cell-ring" aria-hidden="true" />
      <SandFrame selected={active} />
    </div>
  );

  return (
    <>
      {glassCard}
      {hoverPreview && (
        <HoverCardShell
          anchor={hoverPreview.anchor}
          label={cardTitle}
          pointer={hoverCard}
          actions={actions}
          onDismiss={hoverDismiss}
        >
          <HoverCardHeading title={cardTitle} mark={{ kind: 'material' }} index={kindLabel} detail={cardDetails[1]} />
        </HoverCardShell>
      )}
      {mobileMenu && (
        <LibraryItemMobileMenu
          title={cardTitle}
          details={cardDetails}
          actions={actions}
          mobileActions={mobileActions}
          x={mobileMenu.x}
          y={mobileMenu.y}
          onClose={closeMobileMenu}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail — inline preview tile for image / pdf materials.

/** No frame or fill; a PDF page is a small white sheet. */
function LibraryItemThumbnail({
  material,
  onClick,
}: {
  material: LibraryItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const assetThumbnail = useStoredLibraryItemVariant(
    material,
    'thumbnail',
    material.kind === 'image' || material.kind === 'pdf',
  );
  const currentImageKey = `${material.id}:${material.assetId ?? ''}:${assetThumbnail.fileUrl ?? ''}`;
  const errored = errorKey === currentImageKey;
  const src = !errored && material.kind !== 'text' ? assetThumbnail.fileUrl : null;
  if (material.kind === 'text') return null;
  const title = src
    ? t('memoMaterial.preview.open')
    : material.kind === 'pdf' ? t('memoMaterial.preview.generating') : t('memoMaterial.preview.open');
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`library-item-card__thumb library-item-card__thumb--${material.kind}`}
    >
      {src ? (
        <img src={src} alt="" onError={() => setErrorKey(currentImageKey)} />
      ) : material.kind === 'pdf' ? (
        <BrushIcon name="loader" size={13} className="control-spinner" />
      ) : (
        <BrushIcon name="image" size={14} />
      )}
    </button>
  );
}
