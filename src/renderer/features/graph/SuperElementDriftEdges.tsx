import { useCallback, type RefObject } from 'react';
import { RelationArrowMarker } from '../../components/graph/RelationArrowMarker';
import { relationArrowMarkerId, relationEdgePath } from '../../components/graph/relation-edge-visual';
import { measureGraphEdges, sameGraphEdgeGeometry, type GraphDomEdge } from './graph-edge-geometry';
import { useMeasuredGraphEdges } from './useMeasuredGraphEdges';

export interface SuperElementDriftEdgesProps {
  edges: readonly GraphDomEdge[];
  driftCardRefs: RefObject<Map<string, HTMLDivElement>>;
  elementCardRefs: RefObject<Map<string, HTMLDivElement>>;
  layerRef: RefObject<SVGSVGElement | null>;
  panningRef: RefObject<boolean>;
  viewportRef: RefObject<HTMLElement | null>;
  layoutRevision: unknown;
  selectedEdgeId: string | null;
  resolveRelationTypeLabel(id: string): string;
  selectEdge(id: string, x: number, y: number): void;
}

export function SuperElementDriftEdges({ edges, driftCardRefs, elementCardRefs, layerRef,
  panningRef, viewportRef, layoutRevision, selectedEdgeId, resolveRelationTypeLabel, selectEdge,
}: SuperElementDriftEdgesProps) {
  const measure = useCallback(() => measureGraphEdges(edges, (kind, id) => kind === 'node'
    ? driftCardRefs.current.get(id) : elementCardRefs.current.get(id)), [edges, driftCardRefs, elementCardRefs]);
  const geometry = useMeasuredGraphEdges({ measure, equals: sameGraphEdgeGeometry, revision: layoutRevision, animationWindowMs: 600,
    layerRef, panningRef, viewportRef, panEndEvent: 'super-element:pan-end' });
  return (
    <svg
      ref={layerRef}
      className={`drift-edges${selectedEdgeId ? ' is-selected-host' : ''}`}
    >
      {geometry.map((edge) => {
        const markerId = relationArrowMarkerId('super-drift-arrow', edge.id);
        const d = relationEdgePath({
          x1: edge.x1,
          y1: edge.y1,
          x2: edge.x2,
          y2: edge.y2,
          directed: edge.directed,
          targetInsetX: edge.targetInsetX,
          targetInsetY: edge.targetInsetY,
        });
        const selected = selectedEdgeId === edge.id;
        const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
        return (
          <g key={edge.id} className={`drift-edge${selected ? ' is-selected' : ''}`}>
            {edge.directed && (
              <defs>
                <RelationArrowMarker id={markerId} color={edge.color} />
              </defs>
            )}
            <path d={d} className="drift-edge__halo" stroke={edge.color} />
            <path
              d={d}
              className="drift-edge__line"
              stroke={edge.color}
              markerEnd={edge.directed ? `url(#${markerId})` : undefined}
            />
            <path
              d={d}
              className="drift-edge__hit"
              data-super-edge
              stroke="transparent"
              strokeWidth={10}
              fill="none"
              onClick={(e) => {
                e.stopPropagation();
                selectEdge(edge.id, e.clientX, e.clientY);
              }}
            >
              <title>{typeLabel}</title>
            </path>
          </g>
        );
      })}
    </svg>
  );
}
