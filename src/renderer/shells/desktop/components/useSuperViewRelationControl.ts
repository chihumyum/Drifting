import { useCallback, useMemo } from 'react';
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
import { defaultRelationTypeColor } from '../../../components/ui/relation-type-color';

/**
 * What a graph-style Super View shows of its relation types: the types on
 * the canvas with their colours and counts, which are hidden, and the 全部
 * menu that defines them. The header draws it as chips and a word toggle;
 * the element overview draws it as the legend in its canvas's corner.
 */
export function useSuperViewRelationControl(canvas: SuperViewRelationCanvas) {
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
  // What the desktop canvas draws now, kind by kind (its legend): a
  // relation touching an inspiration only while the drift panel is open,
  // and on the element overview only relations between elements (the
  // desktop has no chapter band to end the others on).
  const drawnCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of model.canvasRelations) {
      const drift = (relation.fromKind === 'node' && driftNodeIds.has(relation.fromId))
        || (relation.toKind === 'node' && driftNodeIds.has(relation.toId));
      if (drift ? !driftPanelOpen : canvas === 'element' && (relation.fromKind !== 'element' || relation.toKind !== 'element')) continue;
      counts.set(relation.relationTypeId, (counts.get(relation.relationTypeId) ?? 0) + 1);
    }
    return counts;
  }, [canvas, driftNodeIds, driftPanelOpen, model.canvasRelations]);
  const labelOf = useCallback((relationTypeId: string) => {
    const relationType = relationTypeById.get(relationTypeId);
    return relationType ? presentRelationType(relationType).name : t('relationTypes.missing');
  }, [presentRelationType, relationTypeById, t]);
  const menuProps = {
    relationTypeIds: model.relationTypeIdOrder,
    driftDerivedRelationTypeIds: model.driftDerivedRelationTypeIds,
    hiddenRelationTypeIds,
    onToggleRelationTypeId: toggleRelationTypeId,
    relationTypeCounts: model.relationTypeCounts,
    resolveRelationTypeColor,
    setRelationTypeColor: edgeKindMeta.setColor,
    clearRelationTypeColor: edgeKindMeta.clearColor,
    removeRelationTypeMeta: edgeKindMeta.remove,
    allProjectRelations: entityRelations,
    relationTypes: entityRelationTypes,
    relationTypeGroups: {
      usedTypes: model.usedTypes,
      availableTypes: model.availableTypes,
      otherTypes: model.otherTypes,
    },
    createRelationType: relationTypeUsecases.createRelationType,
    updateRelationType: relationTypeUsecases.updateRelationType,
    deleteRelationType: relationTypeUsecases.deleteRelationType,
  };
  return {
    model, headerRelationTypeIds, drawnCounts, labelOf, resolveRelationTypeColor, hiddenRelationTypeIds,
    toggleRelationTypeId, driftPanelOpen, typeCount: entityRelationTypes.length, menuProps,
  };
}
