import type { EntityRelationLink } from '../../store/data-store';

export interface StoryGraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationTypeId: string;
}

export function projectStoryGraphEdges(
  relations: EntityRelationLink[],
  nodeIds: Set<string>,
): StoryGraphEdge[] {
  const edges: StoryGraphEdge[] = [];
  for (const relation of relations) {
    if (relation.fromKind !== 'node' || relation.toKind !== 'node') continue;
    if (!nodeIds.has(relation.fromId) || !nodeIds.has(relation.toId)) continue;
    edges.push({
      id: relation.id,
      sourceNodeId: relation.fromId,
      targetNodeId: relation.toId,
      relationTypeId: relation.relationTypeId,
    });
  }
  return edges;
}
