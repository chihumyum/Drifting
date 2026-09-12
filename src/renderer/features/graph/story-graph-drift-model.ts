import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { GraphDomEdge } from './graph-edge-geometry';
import type { StoryGraphEdge } from './story-graph-model';

interface StoryGraphDriftInput {
  edges: readonly StoryGraphEdge[];
  driftIds: ReadonlySet<string>;
  hiddenRelationTypeIds: ReadonlySet<string>;
  relationTypeById: ReadonlyMap<string, EntityRelationType>;
  positionedById: ReadonlyMap<string, { storyline?: { color?: string | null } | null }>;
  typeMeta: Readonly<Record<string, { color?: string } | undefined>>;
}

export function projectStoryGraphDriftEdges(input: StoryGraphDriftInput): GraphDomEdge[] {
  const out: GraphDomEdge[] = [];
  for (const edge of input.edges) {
    if (!input.driftIds.has(edge.sourceNodeId) && !input.driftIds.has(edge.targetNodeId)) continue;
    if (input.hiddenRelationTypeIds.has(edge.relationTypeId)) continue;
    const color = input.typeMeta[edge.relationTypeId]?.color
      || input.positionedById.get(edge.sourceNodeId)?.storyline?.color
      || input.positionedById.get(edge.targetNodeId)?.storyline?.color
      || 'hsl(var(--accent))';
    out.push({ id: edge.id, fromKind: 'node', fromId: edge.sourceNodeId, toKind: 'node', toId: edge.targetNodeId,
      relationTypeId: edge.relationTypeId, directed: input.relationTypeById.get(edge.relationTypeId)?.orientation === 'directed', color });
  }
  return out;
}
