import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { EntityRelationLink } from '../../store/data-store';

export type SuperViewRelationCanvas = 'element' | 'graph';
export type CanvasRelationTypeAffinity = 'primary' | 'inspiration' | 'other';

export interface CanvasRelationTypeItem {
  type: EntityRelationType;
  affinity: CanvasRelationTypeAffinity;
  canvasUsageCount: number;
  projectUsageCount: number;
}

export interface SuperViewRelationMenuModel {
  canvasRelations: EntityRelationLink[];
  usedTypes: CanvasRelationTypeItem[];
  availableTypes: CanvasRelationTypeItem[];
  otherTypes: CanvasRelationTypeItem[];
  relationTypeIdOrder: string[];
  relationTypeCounts: Record<string, number>;
  driftDerivedRelationTypeIds: Set<string>;
  worldRelationTypeIds: Set<string>;
}

/** Both endpoints must have a presentation path on the active canvas. */
export function isRelationRenderableOnSuperView(
  relation: Pick<EntityRelationLink, 'fromKind' | 'toKind'>,
  canvas: SuperViewRelationCanvas,
): boolean {
  if (canvas === 'graph') {
    return relation.fromKind === 'node' && relation.toKind === 'node';
  }
  return (
    (relation.fromKind === 'element' &&
      (relation.toKind === 'element' || relation.toKind === 'node')) ||
    (relation.fromKind === 'node' && relation.toKind === 'element')
  );
}

function typeAllowsPair(
  type: EntityRelationType,
  fromKind: 'element' | 'node',
  toKind: 'element' | 'node',
) {
  return type.sourceKinds.includes(fromKind) && type.targetKinds.includes(toKind);
}

/**
 * `node` is the persisted kind for both chapters and inspirations. Existing
 * instances still expose inspiration provenance through endpoint ids, while
 * an unused type can only be ranked at the shared `node` granularity.
 */
export function relationTypeAffinity(
  type: EntityRelationType,
  canvas: SuperViewRelationCanvas,
): CanvasRelationTypeAffinity {
  if (canvas === 'graph') {
    return typeAllowsPair(type, 'node', 'node') ? 'primary' : 'other';
  }
  if (typeAllowsPair(type, 'element', 'element')) return 'primary';
  if (typeAllowsPair(type, 'element', 'node') || typeAllowsPair(type, 'node', 'element')) {
    return 'inspiration';
  }
  return 'other';
}

function compareTypeItems(left: CanvasRelationTypeItem, right: CanvasRelationTypeItem): number {
  const affinityRank = (affinity: CanvasRelationTypeAffinity) =>
    affinity === 'primary' ? 0 : affinity === 'inspiration' ? 1 : 2;
  return (
    affinityRank(left.affinity) - affinityRank(right.affinity) ||
    right.canvasUsageCount - left.canvasUsageCount ||
    right.projectUsageCount - left.projectUsageCount ||
    left.type.normalizedName.localeCompare(right.type.normalizedName)
  );
}

function relationTouchesDrift(
  relation: Pick<EntityRelationLink, 'fromKind' | 'fromId' | 'toKind' | 'toId'>,
  driftNodeIds: ReadonlySet<string>,
): boolean {
  return (
    (relation.fromKind === 'node' && driftNodeIds.has(relation.fromId)) ||
    (relation.toKind === 'node' && driftNodeIds.has(relation.toId))
  );
}

export function buildSuperViewRelationMenuModel({
  canvas,
  relationTypes,
  relations,
  driftNodeIds,
}: {
  canvas: SuperViewRelationCanvas;
  relationTypes: readonly EntityRelationType[];
  relations: readonly EntityRelationLink[];
  driftNodeIds: ReadonlySet<string>;
}): SuperViewRelationMenuModel {
  const canvasRelations = relations.filter((relation) =>
    isRelationRenderableOnSuperView(relation, canvas),
  );
  const projectUsageByTypeId = new Map<string, number>();
  const canvasUsageByTypeId = new Map<string, number>();
  const relationTypeCounts: Record<string, number> = {};
  const driftDerivedRelationTypeIds = new Set<string>();
  const worldRelationTypeIds = new Set<string>();

  for (const relation of relations) {
    projectUsageByTypeId.set(
      relation.relationTypeId,
      (projectUsageByTypeId.get(relation.relationTypeId) ?? 0) + 1,
    );
  }

  for (const relation of canvasRelations) {
    canvasUsageByTypeId.set(
      relation.relationTypeId,
      (canvasUsageByTypeId.get(relation.relationTypeId) ?? 0) + 1,
    );
    relationTypeCounts[relation.relationTypeId] =
      (relationTypeCounts[relation.relationTypeId] ?? 0) + 1;
    if (relationTouchesDrift(relation, driftNodeIds)) {
      driftDerivedRelationTypeIds.add(relation.relationTypeId);
    } else {
      worldRelationTypeIds.add(relation.relationTypeId);
    }
  }

  const items = relationTypes.map<CanvasRelationTypeItem>((type) => ({
    type,
    affinity: relationTypeAffinity(type, canvas),
    canvasUsageCount: canvasUsageByTypeId.get(type.id) ?? 0,
    projectUsageCount: projectUsageByTypeId.get(type.id) ?? 0,
  }));
  const usedTypes = items
    .filter((item) => item.affinity !== 'other' && item.canvasUsageCount > 0)
    .sort(compareTypeItems);
  const availableTypes = items
    .filter((item) => item.affinity !== 'other' && item.canvasUsageCount === 0)
    .sort(compareTypeItems);
  const otherTypes = items.filter((item) => item.affinity === 'other').sort(compareTypeItems);

  return {
    canvasRelations,
    usedTypes,
    availableTypes,
    otherTypes,
    relationTypeIdOrder: usedTypes.map((item) => item.type.id),
    relationTypeCounts,
    driftDerivedRelationTypeIds,
    worldRelationTypeIds,
  };
}
