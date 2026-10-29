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
import { getPlatformRuntime } from '../../platform/runtime';
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
  const [hover, setHover] = useState(false);
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
        { key: 'addRelation', label: t('memoMaterial.menu.addRelation'), onSelect: () => setPickerOpen(true) },
        ...(onMoveToFolder
          ? [{ key: 'moveToFolder', label: t('editorTopBar.menu.moveMaterialToFolder'), onSelect: onMoveToFolder }]
          : []),
      ],
    },
    {
      key: 'system',
      actions: isTextSnippet
        ? []
        : [{ key: 'openInSystem', label: t('memoMaterial.menu.openInSystem'), onSelect: handleOpenInSystem }],
    },
    {
      key: 'delete',
      actions: [{ key: 'delete', label: t('memoMaterial.menu.deleteMaterial'), danger: true, onSelect: onDelete }],
    },
  ].filter((group) => group.actions.length > 0);

  const closeMobileMenu = useCallback(() => setMobileMenu(null), []);

  const openMobileActionMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMobileMenu({ x: rect.right, y: rect.bottom + 4 });
  }, []);

  // Desktop: a material is a sand cell (the upright slip, a ring of flowing
  // glass under the pointer, a frame drawn round the one open in the active
  // tab). The paused mobile shell keeps the older card below.
  const glass = !getPlatformRuntime().isMobileShell;
  const rowEvents = {
    onMouseEnter: (event: React.MouseEvent<HTMLDivElement>) => {
      setHover(true);
      if (hoverEnabled) hoverEnter(null, event.currentTarget);
    },
    onMouseLeave: () => {
      setHover(false);
      hoverLeave();
    },
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
        {!isImageExpanded && <LibraryItemThumbnail material={material} onClick={handleOpenInApp} glass />}
        <div className="library-item-card__text">
          <div className="library-item-card__title-row">
            <KindMark kind="material" color="hsl(var(--ink-3))" />
            {editing ? (
              <span className="library-item-card__title-field glass glass--rest glass--field">{titleInput}</span>
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

  const legacyCard = (
      <div
        className={`workspace-list-row${active ? ' workspace-list-row--active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onMouseEnter={(event) => {
          setHover(true);
          if (hoverEnabled) hoverEnter(null, event.currentTarget);
        }}
        onMouseLeave={() => {
          setHover(false);
          hoverLeave();
        }}
        onPointerDownCapture={hoverDismiss}
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (!onPin || target?.closest('input, textarea, button, [contenteditable="true"]')) return;
          onPin();
        }}
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
          {folderPath && (
            <span className="library-item-card__folder" title={folderPath}>
              {folderPath}
            </span>
          )}
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
          {mobileActions && (
            <button
              type="button"
              className="library-item-card__mobile-menu"
              aria-label={t('common.more')}
              title={t('common.more')}
              onClick={openMobileActionMenu}
            >
              ···
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
                  className="library-item-card__editable-title"
                  onClick={() => {
                    setDraft(material.title);
                    onSetEditing(true);
                  }}
                  title={material.title || subtitle}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t('common.edit')} ${material.title || subtitle || t('common.untitled')}`}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setDraft(material.title);
                    onSetEditing(true);
                  }}
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
                className="library-item-card__editable-title"
                onClick={() => {
                  setDraft(material.title);
                  onSetEditing(true);
                }}
                title={material.title || subtitle}
                role="button"
                tabIndex={0}
                aria-label={`${t('common.edit')} ${material.title || subtitle || t('common.untitled')}`}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  setDraft(material.title);
                  onSetEditing(true);
                }}
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
            <NoteExcerpt
              bodyJson={material.kind === 'text' ? material.bodyJson : null}
              emptyLabel={t('memoMaterial.card.addSnippetBody')}
              clamp={false}
              onOpen={handleOpenInApp}
            />
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
          <div style={{ marginTop: 6 }}>
            <NoteExcerpt
              bodyJson={material.kind === 'text' ? material.bodyJson : null}
              emptyLabel={t('memoMaterial.card.addSnippetBody')}
              clamp
              onOpen={handleOpenInApp}
            />
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
  );

  return (
    <>
      {glass ? glassCard : legacyCard}
      {hoverPreview && (
        <HoverCardShell
          anchor={hoverPreview.anchor}
          label={cardTitle}
          pointer={hoverCard}
          actions={actions}
          onDismiss={hoverDismiss}
        >
          <HoverCardHeading title={cardTitle} detail={cardDetails.join(' · ')} />
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

function LibraryItemThumbnail({
  material,
  onClick,
  glass = false,
}: {
  material: LibraryItem;
  onClick: () => void;
  /** Desktop: no frame or fill; a PDF page is a small white sheet. */
  glass?: boolean;
}) {
  const { t } = useTranslation();
  const size = 64;
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const assetThumbnail = useStoredLibraryItemVariant(
    material,
    'thumbnail',
    material.kind === 'image' || material.kind === 'pdf',
  );
  const currentImageKey = `${material.id}:${material.assetId ?? ''}:${assetThumbnail.fileUrl ?? ''}`;
  const errored = errorKey === currentImageKey;
  const src = !errored && material.kind !== 'text' ? assetThumbnail.fileUrl : null;
  if (glass) {
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
