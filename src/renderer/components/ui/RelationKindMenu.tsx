import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_ENTITY_KINDS,
  STRUCTURAL_ENTITY_KINDS,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
} from '../../domain/entity-kinds';
import type {
  EntityRelationType,
  EntityRelationTypeDefinition,
} from '../../domain/entity-relation-type';
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
  /** All project relations, used only for first-class type usage guards. */
  allProjectRelations?: readonly EntityRelationLink[];
  updateRelationKind: (id: string, kind: string | null) => Promise<unknown>;
  deleteRelation: (id: string) => Promise<unknown>;
  relationTypes?: readonly EntityRelationType[];
  createRelationType?: (definition: EntityRelationTypeDefinition) => Promise<unknown>;
  updateRelationType?: (id: string, definition: EntityRelationTypeDefinition) => Promise<unknown>;
  deleteRelationType?: (id: string) => Promise<unknown>;
  showStorylineTransit?: boolean;
  dismissOnEscape?: boolean;
}

export function RelationTypeEditor({
  value,
  initialSourceKinds,
  initialTargetKinds,
  onSave,
  onCancel,
}: {
  value?: EntityRelationType;
  initialSourceKinds?: readonly EntityRefSourceKind[];
  initialTargetKinds?: readonly EntityRefTargetKind[];
  onSave: (definition: EntityRelationTypeDefinition) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(value?.name ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [orientation, setOrientation] = useState<'directed' | 'symmetric'>(
    value?.orientation === 'symmetric' ? 'symmetric' : 'directed',
  );
  const [sourceRole, setSourceRole] = useState(
    value?.sourceRole || t('relationTypes.defaultSourceRole'),
  );
  const [targetRole, setTargetRole] = useState(
    value?.targetRole || t('relationTypes.defaultTargetRole'),
  );
  const [sourceKinds, setSourceKinds] = useState<EntityRefSourceKind[]>(
    value?.sourceKinds.length
      ? [...value.sourceKinds]
      : initialSourceKinds?.length
        ? [...initialSourceKinds]
        : [...ALL_ENTITY_KINDS],
  );
  const [targetKinds, setTargetKinds] = useState<EntityRefTargetKind[]>(
    value?.targetKinds.length
      ? [...value.targetKinds]
      : initialTargetKinds?.length
        ? [...initialTargetKinds]
        : [...STRUCTURAL_ENTITY_KINDS],
  );
  const [error, setError] = useState('');

  const changeOrientation = (nextOrientation: 'directed' | 'symmetric') => {
    setOrientation(nextOrientation);
    if (nextOrientation !== 'symmetric') return;
    const shared = STRUCTURAL_ENTITY_KINDS.filter(
      (kind) => sourceKinds.includes(kind) || targetKinds.includes(kind),
    );
    setSourceKinds(shared);
    setTargetKinds(shared);
  };

  const toggleSourceKind = (kind: EntityRefSourceKind) => {
    const next = sourceKinds.includes(kind)
      ? sourceKinds.filter((candidate) => candidate !== kind)
      : [...sourceKinds, kind];
    setSourceKinds(next);
    if (
      orientation === 'symmetric' &&
      STRUCTURAL_ENTITY_KINDS.includes(kind as EntityRefTargetKind)
    ) {
      setTargetKinds(
        next.filter((candidate): candidate is EntityRefTargetKind =>
          STRUCTURAL_ENTITY_KINDS.includes(candidate as EntityRefTargetKind),
        ),
      );
    }
  };
  const toggleTargetKind = (kind: EntityRefTargetKind) => {
    const next = targetKinds.includes(kind)
      ? targetKinds.filter((candidate) => candidate !== kind)
      : [...targetKinds, kind];
    setTargetKinds(next);
    if (orientation === 'symmetric') setSourceKinds(next);
  };

  return (
    <div className="relation-type-editor">
      <div className="relation-type-editor__grid">
        <label>
          <span>{t('relationTypes.name')}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label>
          <span>{t('relationTypes.direction')}</span>
          <select
            value={orientation}
            onChange={(event) => changeOrientation(event.target.value as 'directed' | 'symmetric')}
          >
            <option value="directed">{t('relationTypes.directed')}</option>
            <option value="symmetric">{t('relationTypes.symmetric')}</option>
          </select>
        </label>
        <label>
          <span>
            {orientation === 'symmetric'
              ? t('relationTypes.endpointRole')
              : t('relationTypes.sourceRole')}
          </span>
          <input value={sourceRole} onChange={(event) => setSourceRole(event.target.value)} />
        </label>
        {orientation === 'directed' && (
          <label>
            <span>{t('relationTypes.targetRole')}</span>
            <input value={targetRole} onChange={(event) => setTargetRole(event.target.value)} />
          </label>
        )}
      </div>
      <label className="relation-type-editor__description">
        <span>{t('relationTypes.description')}</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="relation-type-editor__endpoint-row">
        <span>
          {orientation === 'symmetric'
            ? t('relationTypes.allowedEntities')
            : t('relationTypes.allowedSources')}
        </span>
        <div>
          {ALL_ENTITY_KINDS.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={sourceKinds.includes(kind)}
                disabled={
                  orientation === 'symmetric' &&
                  !STRUCTURAL_ENTITY_KINDS.includes(kind as EntityRefTargetKind)
                }
                onChange={() => toggleSourceKind(kind)}
              />
              {t(`relationTypes.entityKinds.${kind}`)}
            </label>
          ))}
        </div>
      </div>
      {orientation === 'directed' && (
        <div className="relation-type-editor__endpoint-row">
          <span>{t('relationTypes.allowedTargets')}</span>
          <div>
            {STRUCTURAL_ENTITY_KINDS.map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={targetKinds.includes(kind)}
                  onChange={() => toggleTargetKind(kind)}
                />
                {t(`relationTypes.entityKinds.${kind}`)}
              </label>
            ))}
          </div>
        </div>
      )}
      {error && <div className="relation-type-editor__error">{error}</div>}
      <div className="relation-type-editor__actions">
        <button type="button" onClick={onCancel}>
          {t('relationTypes.cancel')}
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => {
            setError('');
            void onSave({
              name,
              description,
              orientation,
              sourceRole,
              targetRole: orientation === 'symmetric' ? sourceRole : targetRole,
              sourceKinds,
              targetKinds:
                orientation === 'symmetric'
                  ? sourceKinds.filter((kind): kind is EntityRefTargetKind =>
                      STRUCTURAL_ENTITY_KINDS.includes(kind as EntityRefTargetKind),
                    )
                  : targetKinds,
            }).catch((reason) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            );
          }}
        >
          {t('relationTypes.save')}
        </button>
      </div>
    </div>
  );
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
  allProjectRelations = relations,
  updateRelationKind,
  deleteRelation,
  relationTypes = [],
  createRelationType,
  updateRelationType,
  deleteRelationType,
  showStorylineTransit = false,
  dismissOnEscape = true,
}: RelationKindMenuProps) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pickingColor, setPickingColor] = useState<string | null>(null);
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState(false);
  const managesRelationTypes = Boolean(
    createRelationType && updateRelationType && deleteRelationType,
  );

  const dataKind = (kind: string) => (kind === UNCATEGORIZED_RELATION_KIND ? null : kind);
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
    const label = kind === UNCATEGORIZED_RELATION_KIND ? t('storyGraph.edge.uncategorized') : kind;
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
        <div className="relation-kind-menu__section-label">{t('edgeKindManager.filterLabel')}</div>
        {kinds.length === 0 ? (
          <div className="relation-kind-menu__empty">{t('edgeKindManager.empty')}</div>
        ) : (
          <div className="relation-kind-menu__chips">
            {kinds.map((kind) => {
              const label =
                kind === UNCATEGORIZED_RELATION_KIND ? t('storyGraph.edge.uncategorized') : kind;
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

      {managesRelationTypes && (
        <section className="relation-kind-menu__section relation-kind-menu__section--manage">
          <div className="relation-kind-menu__section-title-row">
            <div className="relation-kind-menu__section-label">{t('relationTypes.title')}</div>
            <button type="button" onClick={() => setCreatingType(true)}>
              ＋ {t('relationTypes.create')}
            </button>
          </div>
          {creatingType && (
            <RelationTypeEditor
              onCancel={() => setCreatingType(false)}
              onSave={async (definition) => {
                await createRelationType!(definition);
                setCreatingType(false);
              }}
            />
          )}
          {relationTypes.map((type) => {
            const usageCount = allProjectRelations.filter(
              (relation) => relation.relationTypeId === type.id,
            ).length;
            const colorPickerKey = `relation-type:${type.id}`;
            const isPickingTypeColor = pickingColor === colorPickerKey;
            if (editingTypeId === type.id) {
              return (
                <RelationTypeEditor
                  key={type.id}
                  value={type}
                  onCancel={() => setEditingTypeId(null)}
                  onSave={async (definition) => {
                    await updateRelationType!(type.id, definition);
                    const nextName = definition.name.trim();
                    if (type.name !== nextName) {
                      reassignMeta(type.name, nextName);
                      if (hiddenKinds.has(type.name)) {
                        onToggleKind(type.name);
                        if (!hiddenKinds.has(nextName)) onToggleKind(nextName);
                      }
                    }
                    setEditingTypeId(null);
                  }}
                />
              );
            }
            return (
              <div key={type.id} className="relation-kind-menu__row relation-kind-menu__row--type">
                <button
                  type="button"
                  className="relation-kind-menu__swatch"
                  style={{ background: resolveKindColor(type.name) }}
                  title={t('edgeKindManager.changeColor')}
                  aria-label={t('edgeKindManager.changeColorLabel', { label: type.name })}
                  onClick={() => setPickingColor(isPickingTypeColor ? null : colorPickerKey)}
                />
                {isPickingTypeColor && (
                  <div className="relation-kind-menu__palette" role="listbox">
                    {KIND_PALETTE.map((paletteColor) => (
                      <button
                        key={paletteColor}
                        type="button"
                        className="relation-kind-menu__palette-dot"
                        style={{ background: paletteColor }}
                        onClick={() => {
                          setKindColor(type.name, paletteColor);
                          setPickingColor(null);
                        }}
                      />
                    ))}
                    <button
                      type="button"
                      className="relation-kind-menu__palette-reset"
                      title={t('edgeKindManager.resetColor')}
                      onClick={() => {
                        clearKindColor(type.name);
                        setPickingColor(null);
                      }}
                    >
                      ↺
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="relation-kind-menu__name"
                  onClick={() => setEditingTypeId(type.id)}
                >
                  {type.name}
                  <small>
                    {type.orientation === 'unconfigured'
                      ? t('relationTypes.pending')
                      : type.orientation === 'symmetric'
                        ? t('relationTypes.symmetricSummary', { role: type.sourceRole })
                        : `${type.sourceRole} → ${type.targetRole}`}
                  </small>
                </button>
                <span className="relation-kind-menu__count">{usageCount}</span>
                <button
                  type="button"
                  className="relation-kind-menu__delete"
                  disabled={usageCount > 0}
                  title={usageCount > 0 ? t('relationTypes.inUse') : t('relationTypes.delete')}
                  onClick={() => {
                    if (!window.confirm(t('relationTypes.confirmDelete', { name: type.name })))
                      return;
                    void deleteRelationType!(type.id)
                      .then(() => removeMeta(type.name))
                      .catch((reason) =>
                        window.alert(reason instanceof Error ? reason.message : String(reason)),
                      );
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </section>
      )}

      {!managesRelationTypes && kinds.length > 0 && (
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
                    onBlur={(event) => void handleRename(kind, event.currentTarget.value)}
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
