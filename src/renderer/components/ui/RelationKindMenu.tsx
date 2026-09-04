import { useMemo, useState, type RefObject } from 'react';
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
import { useRelationTypePresentation } from '../../hooks/useRelationTypePresentation';
import { AnchoredPopover } from './AnchoredPopover';
import { FilterChip } from './FilterChip';
import { RELATION_TYPE_PALETTE } from './relation-type-color';
import { requestConfirmation } from '../../store/confirmation-store';

export interface RelationTypeMenuItem {
  type: EntityRelationType;
  canvasUsageCount: number;
  projectUsageCount: number;
}

export interface RelationTypeGroups {
  usedTypes: readonly RelationTypeMenuItem[];
  availableTypes: readonly RelationTypeMenuItem[];
  otherTypes: readonly RelationTypeMenuItem[];
}

export interface RelationKindMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  relationTypeIds: string[];
  driftDerivedRelationTypeIds: ReadonlySet<string>;
  hiddenRelationTypeIds: ReadonlySet<string>;
  onToggleRelationTypeId: (relationTypeId: string) => void;
  relationTypeCounts: Readonly<Record<string, number>>;
  resolveRelationTypeColor: (relationTypeId: string) => string;
  setRelationTypeColor: (relationTypeId: string, color: string) => void;
  clearRelationTypeColor: (relationTypeId: string) => void;
  removeRelationTypeMeta: (relationTypeId: string) => void;
  allProjectRelations: readonly EntityRelationLink[];
  relationTypes: readonly EntityRelationType[];
  relationTypeGroups?: RelationTypeGroups;
  createRelationType?: (definition: EntityRelationTypeDefinition) => Promise<unknown>;
  updateRelationType?: (id: string, definition: EntityRelationTypeDefinition) => Promise<unknown>;
  deleteRelationType?: (id: string) => Promise<unknown>;
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
 * The one relation-type dropdown shared by graph-style Super Views. Current
 * canvas instances are filter chips; every configured type remains available
 * in the ordered management groups below.
 */
export function RelationKindMenu({
  open,
  onClose,
  anchorRef,
  relationTypeIds,
  driftDerivedRelationTypeIds,
  hiddenRelationTypeIds,
  onToggleRelationTypeId,
  relationTypeCounts,
  resolveRelationTypeColor,
  setRelationTypeColor,
  clearRelationTypeColor,
  removeRelationTypeMeta,
  allProjectRelations,
  relationTypes,
  relationTypeGroups,
  createRelationType,
  updateRelationType,
  deleteRelationType,
  dismissOnEscape = true,
}: RelationKindMenuProps) {
  const { t } = useTranslation();
  const presentRelationType = useRelationTypePresentation();
  const [pickingColor, setPickingColor] = useState<string | null>(null);
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState(false);
  const [otherTypesOpen, setOtherTypesOpen] = useState(false);
  const managesRelationTypes = Boolean(
    createRelationType && updateRelationType && deleteRelationType,
  );
  const relationTypeById = useMemo(
    () => new Map(relationTypes.map((type) => [type.id, type])),
    [relationTypes],
  );
  const visibleRelationTypeCount = relationTypeIds.filter(
    (relationTypeId) => !hiddenRelationTypeIds.has(relationTypeId),
  ).length;
  const relationCount = Object.values(relationTypeCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const resolvedTypeGroups = useMemo<RelationTypeGroups>(() => {
    if (relationTypeGroups) return relationTypeGroups;
    const items = relationTypes.map<RelationTypeMenuItem>((type) => {
      const projectUsageCount = allProjectRelations.filter(
        (relation) => relation.relationTypeId === type.id,
      ).length;
      return {
        type,
        canvasUsageCount: relationTypeCounts[type.id] ?? 0,
        projectUsageCount,
      };
    });
    return {
      usedTypes: items.filter((item) => item.canvasUsageCount > 0),
      availableTypes: items.filter((item) => item.canvasUsageCount === 0),
      otherTypes: [],
    };
  }, [allProjectRelations, relationTypeCounts, relationTypeGroups, relationTypes]);

  const renderRelationType = (item: RelationTypeMenuItem) => {
    const { type, canvasUsageCount, projectUsageCount } = item;
    const presentation = presentRelationType(type);
    const colorPickerKey = `relation-type:${type.id}`;
    const isPickingTypeColor = pickingColor === colorPickerKey;
    if (!type.locked && editingTypeId === type.id) {
      return (
        <RelationTypeEditor
          key={type.id}
          value={type}
          onCancel={() => setEditingTypeId(null)}
          onSave={async (definition) => {
            await updateRelationType!(type.id, definition);
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
          style={{ background: resolveRelationTypeColor(type.id) }}
          title={t('edgeKindManager.changeColor')}
          aria-label={t('edgeKindManager.changeColorLabel', {
            label: presentation.name,
          })}
          onClick={() => setPickingColor(isPickingTypeColor ? null : colorPickerKey)}
        />
        {isPickingTypeColor && (
          <div className="relation-kind-menu__palette" role="listbox">
            {RELATION_TYPE_PALETTE.map((paletteColor) => (
              <button
                key={paletteColor}
                type="button"
                className="relation-kind-menu__palette-dot"
                style={{ background: paletteColor }}
                onClick={() => {
                  setRelationTypeColor(type.id, paletteColor);
                  setPickingColor(null);
                }}
              />
            ))}
            <button
              type="button"
              className="relation-kind-menu__palette-reset"
              title={t('edgeKindManager.resetColor')}
              onClick={() => {
                clearRelationTypeColor(type.id);
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
          disabled={type.locked}
          title={type.locked ? t('relationTypes.builtIn') : undefined}
          onClick={() => {
            if (!type.locked) setEditingTypeId(type.id);
          }}
        >
          {presentation.name}
          <small>
            {type.orientation === 'symmetric'
              ? t('relationTypes.symmetricSummary', {
                  role: presentation.sourceRole,
                })
              : `${presentation.sourceRole} → ${presentation.targetRole}`}
            {type.locked ? ` · ${t('relationTypes.builtIn')}` : ''}
          </small>
        </button>
        <span
          className="relation-kind-menu__count"
          title={t('relationTypes.usageSummary', {
            canvas: canvasUsageCount,
            project: projectUsageCount,
          })}
        >
          {canvasUsageCount}/{projectUsageCount}
        </span>
        <button
          type="button"
          className="relation-kind-menu__delete"
          disabled={type.locked || projectUsageCount > 0}
          title={
            type.locked
              ? t('relationTypes.builtInLocked')
              : projectUsageCount > 0
                ? t('relationTypes.inUse')
                : t('relationTypes.delete')
          }
          onClick={() =>
            void (async () => {
              if (type.locked) return;
              const confirmed = await requestConfirmation(
                t('relationTypes.confirmDelete', { name: presentation.name }),
              );
              if (!confirmed) return;
              try {
                await deleteRelationType!(type.id);
                removeRelationTypeMeta(type.id);
              } catch (reason) {
                window.alert(reason instanceof Error ? reason.message : String(reason));
              }
            })()
          }
        >
          ×
        </button>
      </div>
    );
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
              kinds: relationTypes.length,
              relations: relationCount,
            })}
          </div>
        </div>
        <span className="relation-kind-menu__visible-summary">
          {t('edgeKindManager.visibleSummary', {
            visible: visibleRelationTypeCount,
            total: relationTypeIds.length,
          })}
        </span>
      </div>

      <section className="relation-kind-menu__section">
        <div className="relation-kind-menu__section-label">{t('edgeKindManager.filterLabel')}</div>
        {relationTypeIds.length === 0 ? (
          <div className="relation-kind-menu__empty">
            {t('edgeKindManager.noCanvasRelations')}
          </div>
        ) : (
          <div className="relation-kind-menu__chips">
            {relationTypeIds.map((relationTypeId) => {
              const relationType = relationTypeById.get(relationTypeId);
              const label = relationType
                ? presentRelationType(relationType).name
                : t('relationTypes.missing');
              const active = !hiddenRelationTypeIds.has(relationTypeId);
              return (
                <FilterChip
                  key={relationTypeId}
                  size="sm"
                  active={active}
                  markerColor={resolveRelationTypeColor(relationTypeId)}
                  count={relationTypeCounts[relationTypeId] ?? 0}
                  dimmed={!active}
                  className={
                    driftDerivedRelationTypeIds.has(relationTypeId)
                      ? 'filter-chip--drift-edge'
                      : ''
                  }
                  onClick={() => onToggleRelationTypeId(relationTypeId)}
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
          {resolvedTypeGroups.usedTypes.length > 0 && (
            <div className="relation-kind-menu__type-group">
              <div className="relation-kind-menu__group-label">
                {t('relationTypes.usedOnCanvas')}
              </div>
              {resolvedTypeGroups.usedTypes.map(renderRelationType)}
            </div>
          )}
          {resolvedTypeGroups.availableTypes.length > 0 && (
            <div className="relation-kind-menu__type-group">
              <div className="relation-kind-menu__group-label">
                {t('relationTypes.availableOnCanvas')}
              </div>
              {resolvedTypeGroups.availableTypes.map(renderRelationType)}
            </div>
          )}
          {resolvedTypeGroups.otherTypes.length > 0 && (
            <div className="relation-kind-menu__type-group relation-kind-menu__type-group--other">
              <button
                type="button"
                className="relation-kind-menu__other-toggle"
                aria-expanded={otherTypesOpen}
                onClick={() => setOtherTypesOpen((current) => !current)}
              >
                <span>{t('relationTypes.otherTypes')}</span>
                <span>{resolvedTypeGroups.otherTypes.length}</span>
              </button>
              {otherTypesOpen && resolvedTypeGroups.otherTypes.map(renderRelationType)}
            </div>
          )}
          {relationTypes.length === 0 && !creatingType && (
            <div className="relation-kind-menu__empty">{t('edgeKindManager.empty')}</div>
          )}
        </section>
      )}
    </AnchoredPopover>
  );
}
