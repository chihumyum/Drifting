import { useCallback, type RefObject } from 'react';
import { RelationArrowMarker } from '../../components/graph/RelationArrowMarker';
import { relationArrowMarkerId, relationEdgePath } from '../../components/graph/relation-edge-visual';
import { projectSuperElementViewportEdges, sameSuperElementEdges,
  type GraphPoint, type SuperElementViewportInput, type SuperElementWorldEdge } from './super-element-edge-model';
import { useMeasuredGraphEdges } from './useMeasuredGraphEdges';

export type SuperElementViewportConfig = Omit<SuperElementViewportInput, 'pan' | 'zoom' | 'viewportWidth' | 'viewportHeight'>;
interface SuperElementViewportEdgesProps {
  edges: readonly SuperElementWorldEdge[];
  config: SuperElementViewportConfig;
  panRef: RefObject<GraphPoint>;
  zoomRef: RefObject<number>;
  viewportRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<SVGSVGElement | null>;
  panningRef: RefObject<boolean>;
  revision: unknown;
  selectedEdgeId: string | null;
  focusedEdgeIds?: ReadonlySet<string>;
  selectEdge(id: string, x: number, y: number): void;
  resolveRelationTypeLabel(id: string): string;
}
const EDGE_HIT_WIDTH = 10;
const EDGE_SELECTED_WIDTH = 2.4;
const EDGE_DEFAULT_WIDTH = 1.6;

export function SuperElementViewportEdges({ edges, config, panRef, zoomRef, viewportRef, layerRef,
  panningRef, revision, selectedEdgeId, focusedEdgeIds, selectEdge, resolveRelationTypeLabel,
}: SuperElementViewportEdgesProps) {
  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    return viewport ? projectSuperElementViewportEdges(edges, { ...config, pan: panRef.current, zoom: zoomRef.current,
      viewportWidth: viewport.clientWidth, viewportHeight: viewport.clientHeight }) : [];
  }, [edges, config, panRef, zoomRef, viewportRef]);
  const geometry = useMeasuredGraphEdges({ measure, equals: sameSuperElementEdges, revision,
    animationWindowMs: 0, layerRef, panningRef, viewportRef, panEndEvent: 'super-element:pan-end' });
  return (
    <svg
      ref={layerRef}
      className="super-viewport-edges"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        // ABOVE the sticky band (zIndex 5) so connection lines stay
        // visible even where they cross the band — matches the
        // non-sticky behaviour where the in-world edge SVG is
        // rendered after the band in DOM order and so sits on top.
        // Element cards (in the world transform, default stacking
        // context) still get hidden behind the band; edges don't.
        zIndex: 10,
      }}
    >
      {geometry.map((edge) => {
        // Same click-focus boost as the world-space layer above.
        const selected = selectedEdgeId === edge.id || !!focusedEdgeIds?.has(edge.id);
        const markerId = relationArrowMarkerId('super-viewport-arrow', edge.id);
        const d = relationEdgePath({
          x1: edge.x1,
          y1: edge.y1,
          x2: edge.x2,
          y2: edge.y2,
          directed: edge.directed,
          targetInsetX: edge.targetInsetX,
          targetInsetY: edge.targetInsetY,
        });
        const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
        return (
          <g key={edge.id} data-super-edge>
            {edge.directed && (
              <defs>
                <RelationArrowMarker id={markerId} color={edge.color} />
              </defs>
            )}
            <path
              d={d}
              stroke="transparent"
              strokeWidth={EDGE_HIT_WIDTH}
              fill="none"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                selectEdge(edge.id, e.clientX, e.clientY);
              }}
            >
              <title>{`${edge.fromName} → ${edge.toName}  ·  ${typeLabel}`}</title>
            </path>
            <path
              d={d}
              stroke={edge.color}
              strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
              fill="none"
              opacity={selected ? 1 : 0.78}
              markerEnd={edge.directed ? `url(#${markerId})` : undefined}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        );
      })}
    </svg>
  );
}
