import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityRelationLink } from '../../store/data-store';
import { AnchoredPopover } from './AnchoredPopover';
import { FilterChip } from './FilterChip';

const KIND_PALETTE = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
  'hsl(var(--ink-3))',
];

export const UNCATEGORIZED_RELATION_KIND = '__uncategorized__';

export interface RelationKindMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Every kind in this surface, including the uncategorized sentinel. */
  kinds: string[];
  /** Kinds backed by an edge derived from the bottom Drift Panel. */
  driftDerivedKinds: ReadonlySet<string>;
  hiddenKinds: ReadonlySet<string>;
  onToggleKind: (kind: string) => void;
  kindCounts: Readonly<Record<string, number>>;
  resolveKindColor: (kind: string | null) => string;
  setKindColor: (kind: string | null, color: string) => void;
  clearKindColor: (kind: string | null) => void;
  reassignMeta: (oldKind: string | null, newKind: string | null) => void;
  removeMeta: (kind: string | null) => void;
  /** Relations managed by this view. Rename/delete never escape this scope. */
  relations: EntityRelationLink[];
  updateRelationKind: (id: string, kind: string | null) => Promise<unknown>;
  deleteRelation: (id: string) => Promise<unknown>;
  showStorylineTransit?: boolean;
  dismissOnEscape?: boolean;
}

/**
 * The one relation-type dropdown shared by graph-style super views. It always
 * exposes every type as a filter chip, then provides the richer management
 * details below; the header's inline chip strip is only a space-dependent
 * shortcut and never owns a second menu.
 */
export function RelationKindMenu({
  open,
  onClose,
  anchorRef,
  kinds,
  driftDerivedKinds,
  hiddenKinds,
  onToggleKind,
  kindCounts,
  resolveKindColor,
  setKindColor,
  clearKindColor,
  reassignMeta,
  removeMeta,
  relations,
  updateRelationKind,
  deleteRelation,
  showStorylineTransit = false,
  dismissOnEscape = true,
}: RelationKindMenuProps) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pickingColor, setPickingColor] = useState<string | null>(null);

  const dataKind = (kind: string) =>
    kind === UNCATEGORIZED_RELATION_KIND ? null : kind;
  const visibleKindCount = kinds.filter((kind) => !hiddenKinds.has(kind)).length;

  const handleRename = async (oldKind: string, newKindRaw: string) => {
    const newKind = newKindRaw.trim();
    if (!newKind || newKind === oldKind) {
      setEditingName(null);
      return;
    }
    const oldKindForData = dataKind(oldKind);
    const affected = relations.filter((relation) => (relation.kind ?? null) === oldKindForData);
    for (const relation of affected) {
      try {
        await updateRelationKind(relation.id, newKind);
      } catch {
        // A partial bulk rename is still recoverable and preferable to
        // abandoning the remaining independent relation updates.
      }
    }
    reassignMeta(oldKindForData, newKind);
    if (hiddenKinds.has(oldKind)) {
      onToggleKind(oldKind);
      if (!kinds.includes(newKind) && !hiddenKinds.has(newKind)) onToggleKind(newKind);
    }
    setEditingName(null);
  };

  const handleDelete = async (kind: string) => {
    const label =
      kind === UNCATEGORIZED_RELATION_KIND
        ? t('storyGraph.edge.uncategorized')
        : kind;
    if (!window.confirm(t('edgeKindManager.confirmDeleteKind', { label }))) return;
    const target = dataKind(kind);
    const affected = relations.filter((relation) => (relation.kind ?? null) === target);
    for (const relation of affected) {
      try {
        await deleteRelation(relation.id);
      } catch {
        // Continue so one failed row does not block deletion of the rest.
      }
    }
    removeMeta(target);
    if (hiddenKinds.has(kind)) onToggleKind(kind);
  };

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      placement="bottom-end"
      role="menu"
      ariaLabel={t('edgeKindManager.title')}
      className="menu-surface menu-surface--rich menu-surface--settings relation-kind-menu"
      maxHeight={480}
      dismissOnEscape={dismissOnEscape}
    >
      <div className="relation-kind-menu__head">
        <div>
          <div className="relation-kind-menu__title">{t('edgeKindManager.title')}</div>
          <div className="relation-kind-menu__summary">
            {t('edgeKindManager.summary', {
              kinds: kinds.length,
              relations: relations.length,
            })}
          </div>
        </div>
        <span className="relation-kind-menu__visible-summary">
          {t('edgeKindManager.visibleSummary', {
            visible: visibleKindCount,
            total: kinds.length,
          })}
        </span>
      </div>

      <section className="relation-kind-menu__section">
        <div className="relation-kind-menu__section-label">
          {t('edgeKindManager.filterLabel')}
        </div>
        {kinds.length === 0 ? (
          <div className="relation-kind-menu__empty">{t('edgeKindManager.empty')}</div>
        ) : (
          <div className="relation-kind-menu__chips">
            {kinds.map((kind) => {
              const label =
                kind === UNCATEGORIZED_RELATION_KIND
                  ? t('storyGraph.edge.uncategorized')
                  : kind;
              const active = !hiddenKinds.has(kind);
              return (
                <FilterChip
                  key={kind}
                  size="sm"
                  active={active}
                  markerColor={resolveKindColor(dataKind(kind))}
                  count={kindCounts[kind] ?? 0}
                  dimmed={!active}
                  className={driftDerivedKinds.has(kind) ? 'filter-chip--drift-edge' : ''}
                  onClick={() => onToggleKind(kind)}
                  title={
                    active
                      ? t('storyGraph.edge.hideKind', { label })
                      : t('storyGraph.edge.showKind', { label })
                  }
                >
                  {label}
                </FilterChip>
              );
            })}
          </div>
        )}
      </section>

      {kinds.length > 0 && (
        <section className="relation-kind-menu__section relation-kind-menu__section--manage">
          <div className="relation-kind-menu__section-label">
            {t('edgeKindManager.manageLabel')}
          </div>
          {kinds.map((kind) => {
            const isUncategorized = kind === UNCATEGORIZED_RELATION_KIND;
            const label = isUncategorized ? t('storyGraph.edge.uncategorized') : kind;
            const color = resolveKindColor(dataKind(kind));
            const isEditingName = editingName === kind;
            const isPickingColor = pickingColor === kind;
            return (
              <div key={kind} className="relation-kind-menu__row">
                <button
                  type="button"
                  className="relation-kind-menu__swatch"
                  style={{ background: color }}
                  title={t('edgeKindManager.changeColor')}
                  onClick={() => setPickingColor(isPickingColor ? null : kind)}
                  aria-label={t('edgeKindManager.changeColorLabel', { label })}
                />
                {isPickingColor && (
                  <div className="relation-kind-menu__palette" role="listbox">
                    {KIND_PALETTE.map((paletteColor) => (
                      <button
                        key={paletteColor}
                        type="button"
                        className="relation-kind-menu__palette-dot"
                        style={{ background: paletteColor }}
                        onClick={() => {
                          setKindColor(dataKind(kind), paletteColor);
                          setPickingColor(null);
                        }}
                      />
                    ))}
                    <button
                      type="button"
                      className="relation-kind-menu__palette-reset"
                      title={t('edgeKindManager.resetColor')}
                      onClick={() => {
                        clearKindColor(dataKind(kind));
                        setPickingColor(null);
                      }}
                    >
                      ↺
                    </button>
                  </div>
                )}

                {isEditingName ? (
                  <input
                    className="relation-kind-menu__name-input"
                    defaultValue={isUncategorized ? '' : kind}
                    placeholder={
                      isUncategorized
                        ? t('edgeKindManager.nameUncategorizedPlaceholder')
                        : undefined
                    }
                    autoFocus
                    onBlur={(event) =>
                      void handleRename(kind, event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setEditingName(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="relation-kind-menu__name"
                    onClick={() => setEditingName(kind)}
                    title={
                      isUncategorized
                        ? t('edgeKindManager.nameUncategorizedTitle')
                        : t('edgeKindManager.renameTitle')
                    }
                  >
                    {label}
                  </button>
                )}

                <span
                  className="relation-kind-menu__count"
                  title={t('edgeKindManager.relationCountTitle', {
                    label,
                    count: kindCounts[kind] ?? 0,
                  })}
                >
                  {kindCounts[kind] ?? 0}
                </span>
                <button
                  type="button"
                  className="relation-kind-menu__delete"
                  title={t('edgeKindManager.deleteKindTitle', { label })}
                  onClick={() => void handleDelete(kind)}
                  aria-label={t('edgeKindManager.deleteKindLabel', { label })}
                >
                  ×
                </button>
              </div>
            );
          })}
        </section>
      )}

      {showStorylineTransit && (
        <div className="relation-kind-menu__row is-locked">
          <span className="relation-kind-menu__swatch is-dashed" aria-hidden />
          <span className="relation-kind-menu__name is-static">
            {t('edgeKindManager.storylineTransit')}
          </span>
          <span
            className="relation-kind-menu__hint"
            title={t('edgeKindManager.storylineTransitTitle')}
          >
            {t('edgeKindManager.lockedHint')}
          </span>
        </div>
      )}
    </AnchoredPopover>
  );
}
