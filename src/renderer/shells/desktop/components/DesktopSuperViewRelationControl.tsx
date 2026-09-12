import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isDrift } from '../../../domain/book-node';
import {
  buildSuperViewRelationMenuModel,
  type SuperViewRelationCanvas,
} from '../../../features/graph/super-view-relation-menu-model';
import { useSuperViewRelationUi } from '../../../features/graph/super-view-relation-ui-context';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useRelationTypePresentation } from '../../../hooks/useRelationTypePresentation';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { useEntityRelationTypes } from '../../../usecase/useEntityRelationTypes';
import { FilterChip } from '../../../components/ui/FilterChip';
import { HeaderChipStrip } from '../../../components/ui/HeaderChipStrip';
import { RelationKindMenu } from '../../../components/ui/RelationKindMenu';
import { defaultRelationTypeColor } from '../../../components/ui/relation-type-color';

export function DesktopSuperViewRelationControl({ canvas }: { canvas: SuperViewRelationCanvas }) {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const presentRelationType = useRelationTypePresentation();
  const { bookNodes, entityRelations, entityRelationTypes } = useDataStoreFields('bookNodes', 'entityRelations', 'entityRelationTypes');
  const {
    hiddenRelationTypeIds,
    driftPanelOpen,
    toggleRelationTypeId,
    edgeKindMeta,
  } = useSuperViewRelationUi(canvas);
  const relationTypeUsecases = useEntityRelationTypes({ projectId: projectId ?? '' });
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const driftNodeIds = useMemo(
    () => new Set(bookNodes.filter(isDrift).map((node) => node.id)),
    [bookNodes],
  );
  const model = useMemo(
    () =>
      buildSuperViewRelationMenuModel({
        canvas,
        relationTypes: entityRelationTypes,
        relations: entityRelations,
        driftNodeIds,
      }),
    [canvas, driftNodeIds, entityRelationTypes, entityRelations],
  );
  const relationTypeById = useMemo(
    () => new Map(entityRelationTypes.map((type) => [type.id, type])),
    [entityRelationTypes],
  );
  const resolveRelationTypeColor = useCallback(
    (relationTypeId: string) =>
      edgeKindMeta.meta[relationTypeId]?.color ?? defaultRelationTypeColor(relationTypeId),
    [edgeKindMeta.meta],
  );
  const headerRelationTypeIds = model.relationTypeIdOrder.filter(
    (relationTypeId) =>
      model.worldRelationTypeIds.has(relationTypeId) ||
      (driftPanelOpen && model.driftDerivedRelationTypeIds.has(relationTypeId)),
  );

  return (
    <>
      <HeaderChipStrip>
        {headerRelationTypeIds.map((relationTypeId) => {
          const relationType = relationTypeById.get(relationTypeId);
          const label = relationType
            ? presentRelationType(relationType).name
            : t('relationTypes.missing');
          const active = !hiddenRelationTypeIds.has(relationTypeId);
          return (
            <FilterChip
              key={relationTypeId}
              size="sm"
              activeStyle="solid"
              active={active}
              markerColor={resolveRelationTypeColor(relationTypeId)}
              dimmed={!active}
              className={
                driftPanelOpen && model.driftDerivedRelationTypeIds.has(relationTypeId)
                  ? 'filter-chip--drift-edge'
                  : ''
              }
              onClick={() => toggleRelationTypeId(relationTypeId)}
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
      </HeaderChipStrip>
      <div
        className="relation-kind-menu-anchor super-view-head__no-drag"
        data-tauri-drag-region="false"
      >
        <button
          ref={buttonRef}
          type="button"
          className={`relation-kind-menu-trigger${open ? ' is-open' : ''}`}
          onClick={() => setOpen((current) => !current)}
          title={t('edgeKindManager.openAllTitle')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span>{t('edgeKindManager.all')}</span>
          <span className="relation-kind-menu-trigger__count">{entityRelationTypes.length}</span>
        </button>
        <RelationKindMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={buttonRef}
          relationTypeIds={model.relationTypeIdOrder}
          driftDerivedRelationTypeIds={model.driftDerivedRelationTypeIds}
          hiddenRelationTypeIds={hiddenRelationTypeIds}
          onToggleRelationTypeId={toggleRelationTypeId}
          relationTypeCounts={model.relationTypeCounts}
          resolveRelationTypeColor={resolveRelationTypeColor}
          setRelationTypeColor={edgeKindMeta.setColor}
          clearRelationTypeColor={edgeKindMeta.clearColor}
          removeRelationTypeMeta={edgeKindMeta.remove}
          allProjectRelations={entityRelations}
          relationTypes={entityRelationTypes}
          relationTypeGroups={{
            usedTypes: model.usedTypes,
            availableTypes: model.availableTypes,
            otherTypes: model.otherTypes,
          }}
          createRelationType={relationTypeUsecases.createRelationType}
          updateRelationType={relationTypeUsecases.updateRelationType}
          deleteRelationType={relationTypeUsecases.deleteRelationType}
        />
      </div>
    </>
  );
}
