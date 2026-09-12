import { useCallback, useRef, type RefObject } from 'react';
import { RelationArrowMarker } from '../../components/graph/RelationArrowMarker';
import { relationArrowMarkerId, relationEdgePath } from '../../components/graph/relation-edge-visual';
import { measureGraphEdges, sameGraphEdgeGeometry, type GraphDomEdge } from './graph-edge-geometry';
import { useMeasuredGraphEdges } from './useMeasuredGraphEdges';

interface StoryGraphDriftEdgesProps {
  edges: readonly GraphDomEdge[];
  driftCardRefs: RefObject<Map<string, HTMLDivElement>>;
  tileRefs: RefObject<Map<string, HTMLDivElement>>;
  viewportRef: RefObject<HTMLDivElement | null>;
  revision: unknown;
  selectedEdgeId: string | null;
  selectEdge(id: string, x: number, y: number): void;
  resolveRelationTypeLabel(id: string): string;
}

export function StoryGraphDriftEdges({ edges, driftCardRefs, tileRefs, viewportRef, revision,
  selectedEdgeId, selectEdge, resolveRelationTypeLabel }: StoryGraphDriftEdgesProps) {
  const layerRef = useRef<SVGSVGElement | null>(null);
  const panningRef = useRef(false);
  const measure = useCallback(() => measureGraphEdges(edges, (_kind, id) =>
    driftCardRefs.current.get(id) ?? tileRefs.current.get(id)), [edges, driftCardRefs, tileRefs]);
  const geometry = useMeasuredGraphEdges({ measure, equals: sameGraphEdgeGeometry, revision,
    animationWindowMs: 500, layerRef, panningRef, viewportRef });
  return (
    <svg ref={layerRef} className="graph-drift-edges" aria-hidden>
      <defs>
        <filter id="drift-edge-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {geometry.map((g) => {
        const markerId = relationArrowMarkerId('story-drift-arrow', g.id);
        const d = relationEdgePath({
          x1: g.x1,
          y1: g.y1,
          x2: g.x2,
          y2: g.y2,
          directed: g.directed,
          targetInsetX: g.targetInsetX,
          targetInsetY: g.targetInsetY,
        });
        const selected = selectedEdgeId === g.id;
        return (
          <g key={g.id} className={`graph-drift-edge${selected ? ' is-selected' : ''}`}>
            {g.directed && (
              <defs>
                <RelationArrowMarker id={markerId} color={g.color} />
              </defs>
            )}
            <path
              className="graph-drift-edge__hit"
              d={d}
              stroke="transparent"
              strokeWidth={12}
              fill="none"
              onClick={(e) => {
                e.stopPropagation();
                selectEdge(g.id, e.clientX, e.clientY);
              }}
            >
              <title>
                {resolveRelationTypeLabel(g.relationTypeId)}
              </title>
            </path>
            <path className="graph-drift-edge__halo" d={d} stroke={g.color} />
            <path
              className="graph-drift-edge__line"
              d={d}
              stroke={g.color}
              markerEnd={g.directed ? `url(#${markerId})` : undefined}
            />
          </g>
        );
      })}
    </svg>
  );
}
