export interface GraphDomEdge {
  id: string;
  fromKind: 'node' | 'element';
  fromId: string;
  toKind: 'node' | 'element';
  toId: string;
  relationTypeId: string;
  directed: boolean;
  color: string;
}

export interface GraphEdgeGeometry {
  id: string;
  relationTypeId: string;
  directed: boolean;
  color: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  targetInsetX: number;
  targetInsetY: number;
}

export interface GraphEndpoint {
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
}
export type GraphEndpointResolver = (kind: GraphDomEdge['fromKind'], id: string) => GraphEndpoint | undefined;

/** One read phase. Missing (filtered/unmounted) endpoints produce no edge. */
export function measureGraphEdges(edges: readonly GraphDomEdge[], resolve: GraphEndpointResolver): GraphEdgeGeometry[] {
  const out: GraphEdgeGeometry[] = [];
  const rects = new Map<GraphEndpoint, ReturnType<GraphEndpoint['getBoundingClientRect']>>();
  const read = (endpoint: GraphEndpoint) => {
    let rect = rects.get(endpoint);
    if (!rect) { rect = endpoint.getBoundingClientRect(); rects.set(endpoint, rect); }
    return rect;
  };
  for (const edge of edges) {
    const from = resolve(edge.fromKind, edge.fromId);
    const to = resolve(edge.toKind, edge.toId);
    if (!from || !to) continue;
    const source = read(from);
    const target = read(to);
    out.push({ id: edge.id, relationTypeId: edge.relationTypeId, directed: edge.directed, color: edge.color,
      x1: source.left + source.width / 2, y1: source.top + source.height / 2,
      x2: target.left + target.width / 2, y2: target.top + target.height / 2,
      targetInsetX: target.width / 2 + 6, targetInsetY: target.height / 2 + 6 });
  }
  return out;
}

const geometryKeys: (keyof GraphEdgeGeometry)[] = [
  'id', 'relationTypeId', 'directed', 'color', 'x1', 'y1', 'x2', 'y2', 'targetInsetX', 'targetInsetY',
];
export function sameGraphEdgeGeometry(a: readonly GraphEdgeGeometry[], b: readonly GraphEdgeGeometry[]): boolean {
  return a === b || (a.length === b.length && a.every((edge, index) => geometryKeys.every((key) => edge[key] === b[index][key])));
}
