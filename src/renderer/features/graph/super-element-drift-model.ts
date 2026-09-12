import type { SuperElementEdgeInput } from './super-element-edge-model';
import type { GraphDomEdge } from './graph-edge-geometry';

export type SuperElementDriftInput = Pick<SuperElementEdgeInput,
  'entityRelations' | 'hiddenRelationTypeIds' | 'driftIds' | 'relationTypeById' | 'resolveRelationTypeColor'>;

/** Classify with the full project drift set, independently of visible cards. */
export function projectSuperElementDriftEdges(input: SuperElementDriftInput): GraphDomEdge[] {
  const out: GraphDomEdge[] = [];
  for (const edge of input.entityRelations) {
    if (input.hiddenRelationTypeIds.has(edge.relationTypeId)) continue;
    const fromDrift = edge.fromKind === 'node' && input.driftIds.has(edge.fromId);
    const toDrift = edge.toKind === 'node' && input.driftIds.has(edge.toId);
    if (!((fromDrift && edge.toKind === 'element') || (toDrift && edge.fromKind === 'element'))) continue;
    out.push({ id: edge.id, fromId: edge.fromId, toId: edge.toId,
      fromKind: fromDrift ? 'node' : 'element', toKind: toDrift ? 'node' : 'element',
      relationTypeId: edge.relationTypeId,
      directed: input.relationTypeById.get(edge.relationTypeId)?.orientation === 'directed',
      color: input.resolveRelationTypeColor(edge.relationTypeId) });
  }
  return out;
}
