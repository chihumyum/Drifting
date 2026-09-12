import { indexById } from '../../lib/immutable-id-index';
import type { BookElement } from '../../domain/book-element';
import type { BookNode } from '../../domain/book-node';
import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { EntityRelationLink } from '../../store/data-store';

export interface GraphPoint { x: number; y: number }
export interface SuperElementEdgeInput {
  entityRelations: readonly EntityRelationLink[];
  hiddenRelationTypeIds: ReadonlySet<string>;
  bookElements: readonly BookElement[];
  bookNodes: readonly BookNode[];
  elementCenters: ReadonlyMap<string, GraphPoint>;
  nodeCenters: ReadonlyMap<string, GraphPoint>;
  driftIds: ReadonlySet<string>;
  relationTypeById: ReadonlyMap<string, EntityRelationType>;
  resolveRelationTypeColor(id: string): string;
  cellWidth: number;
  cellHeight: number;
  bandPillWidth: number;
}

export interface SuperElementWorldEdge {
  fromKind: 'element' | 'node';
  toKind: 'element' | 'node';
  id: string;
  refId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  relationTypeId: string;
  directed: boolean;
  targetInsetX: number;
  targetInsetY: number;
  color: string;
  fromName: string;
  toName: string;
}

/** Pure world-space edge projection, shared by world and sticky viewport layers. */
export function buildSuperElementWorldEdges(input: SuperElementEdgeInput): SuperElementWorldEdge[] {
  const { entityRelations, hiddenRelationTypeIds, bookElements, bookNodes, elementCenters, nodeCenters,
    driftIds, relationTypeById, resolveRelationTypeColor, cellWidth: CELL_W, cellHeight: CELL_H, bandPillWidth: BAND_PILL_PX } = input;
  const elementsById = indexById(bookElements);
  const nodesById = indexById(bookNodes);
  const out: SuperElementWorldEdge[] = [];
  for (const ref of entityRelations) {
    if (hiddenRelationTypeIds.has(ref.relationTypeId)) continue;
    const fromIsEl = ref.fromKind === 'element';
    const toIsEl = ref.toKind === 'element';
    const fromIsNode = ref.fromKind === 'node';
    const toIsNode = ref.toKind === 'node';
    if (!fromIsEl && !toIsEl) continue;
    if (fromIsNode && driftIds.has(ref.fromId)) continue;
    if (toIsNode && driftIds.has(ref.toId)) continue;
    const fromPt = fromIsEl
      ? elementCenters.get(ref.fromId)
      : fromIsNode
        ? nodeCenters.get(ref.fromId)
        : null;
    const toPt = toIsEl
      ? elementCenters.get(ref.toId)
      : toIsNode
        ? nodeCenters.get(ref.toId)
        : null;
    if (!fromPt || !toPt) continue;
    const fromName = fromIsEl
      ? (elementsById.get(ref.fromId)?.name ?? '?')
      : fromIsNode
        ? (nodesById.get(ref.fromId)?.title ?? '?')
        : '?';
    const toName = toIsEl
      ? (elementsById.get(ref.toId)?.name ?? '?')
      : toIsNode
        ? (nodesById.get(ref.toId)?.title ?? '?')
        : '?';
    out.push({
      fromKind: fromIsEl ? 'element' : 'node',
      toKind: toIsEl ? 'element' : 'node',
      id: ref.id,
      refId: ref.id,
      x1: fromPt.x,
      y1: fromPt.y,
      x2: toPt.x,
      y2: toPt.y,
      relationTypeId: ref.relationTypeId,
      directed: relationTypeById.get(ref.relationTypeId)?.orientation === 'directed',
      targetInsetX: (toIsNode ? BAND_PILL_PX : CELL_W) / 2 + 6,
      targetInsetY: CELL_H / 2 + 6,
      color: resolveRelationTypeColor(ref.relationTypeId),
      fromName,
      toName,
    });
  }
  return out;
}

export interface SuperElementViewportInput {
  pan: GraphPoint;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  bandSticky: boolean;
  edgesViewportOnly: boolean;
  bandTopWorldY: number;
  bandHeightCells: number;
  cellWidth: number;
  cellHeight: number;
}

/** Reuse world filtering, labels and styling; only geometry depends on pan/zoom. */
export function projectSuperElementViewportEdges(
  edges: readonly SuperElementWorldEdge[],
  input: SuperElementViewportInput,
): SuperElementWorldEdge[] {
  const { pan, zoom, viewportWidth, viewportHeight, bandSticky, edgesViewportOnly,
    bandTopWorldY, bandHeightCells, cellWidth, cellHeight } = input;
  if (!bandSticky && !edgesViewportOnly) return [];
  const bandHeight = bandHeightCells * cellHeight * zoom;
  const naturalBandY = pan.y + zoom * bandTopWorldY;
  let bandY = naturalBandY;
  if (bandSticky) {
    // Match the actual band's transform, including a band taller than the viewport.
    if (naturalBandY < 0) bandY = 0;
    else if (naturalBandY + bandHeight > viewportHeight) bandY = viewportHeight - bandHeight;
  }
  const elementVisible = (x: number, y: number) => {
    if (!edgesViewportOnly) return true;
    const halfWidth = cellWidth * zoom / 2;
    const halfHeight = cellHeight * zoom / 2;
    if (x + halfWidth < 0 || x - halfWidth > viewportWidth) return false;
    if (y + halfHeight < 0 || y - halfHeight > viewportHeight) return false;
    return !(bandSticky && y > bandY && y < bandY + bandHeight);
  };
  const screenY = (kind: SuperElementWorldEdge['fromKind'], worldY: number) => kind === 'element'
    ? pan.y + zoom * worldY
    : bandY + zoom * (worldY - bandTopWorldY);
  const out: SuperElementWorldEdge[] = [];
  for (const edge of edges) {
    const x1 = pan.x + zoom * edge.x1;
    const y1 = screenY(edge.fromKind, edge.y1);
    const x2 = pan.x + zoom * edge.x2;
    const y2 = screenY(edge.toKind, edge.y2);
    if (edge.fromKind === 'element' && !elementVisible(x1, y1)) continue;
    if (edge.toKind === 'element' && !elementVisible(x2, y2)) continue;
    out.push({ ...edge, x1, y1, x2, y2,
      targetInsetX: edge.targetInsetX * zoom, targetInsetY: edge.targetInsetY * zoom });
  }
  return out;
}
