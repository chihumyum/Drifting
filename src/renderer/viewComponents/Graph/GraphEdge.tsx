import { memo } from 'react';
import { BookNodeEdge } from '../../domain/book-node';
import { BookNodePosition } from '../../domain/book-node';
import loglevel from "loglevel";

const log = loglevel.getLogger("GraphEdge");
log.setLevel(loglevel.levels.ERROR);

interface GraphEdgeProps {
    edge: BookNodeEdge;
    sourcePos: BookNodePosition;
    targetPos: BookNodePosition;
    isSelected: boolean;
    onSelect: (id: string) => void;
    style?: React.CSSProperties; // Add style prop
    customMarkerId?: string; // Custom marker for storyline edges
    onControlMouseDown?: (e: React.MouseEvent, edgeId: string) => void;
    onAnchorMouseDown?: (e: React.MouseEvent, edgeId: string, type: 'source' | 'target') => void;
}

export const GraphEdge = memo(({ edge, sourcePos, targetPos, isSelected, onSelect, style, customMarkerId, onControlMouseDown, onAnchorMouseDown }: GraphEdgeProps) => {
    if (!sourcePos.x || !sourcePos.y || !targetPos.x || !targetPos.y) return null;

    // Check if this is a storyline edge (has customMarkerId)
    const isStorylineEdge = !!customMarkerId;
    
    // Debug: log style for storyline edges
    if (isStorylineEdge && style) {
        log.debug('GraphEdge - isStorylineEdge:', isStorylineEdge, 'customMarkerId:', customMarkerId, 'style.stroke:', style.stroke);
    }

    // Node dimensions
    const nodeW = 240;
    const nodeH = 160;
    const halfW = nodeW / 2;
    const halfH = nodeH / 2;

    // Helper: Calculate point on border
    const getPointOnBorder = (centerX: number, centerY: number, targetX: number, targetY: number, anchor?: { x: number, y: number }) => {
        if (anchor) {
            // Use stored anchor (already on border)
            return { x: centerX + anchor.x, y: centerY + anchor.y };
        }
        
        // Calculate intersection with node border
        const dx = targetX - centerX;
        const dy = targetY - centerY;
        
        if (dx === 0 && dy === 0) return { x: centerX + halfW, y: centerY };
        
        // Calculate ratios to reach each edge
        const tLeft = dx < 0 ? -halfW / dx : Infinity;
        const tRight = dx > 0 ? halfW / dx : Infinity;
        const tTop = dy < 0 ? -halfH / dy : Infinity;
        const tBottom = dy > 0 ? halfH / dy : Infinity;
        
        const t = Math.min(tLeft, tRight, tTop, tBottom);
        
        return {
            x: centerX + dx * t,
            y: centerY + dy * t
        };
    };

    // Calculate edge endpoints on borders
    const sourcePoint = getPointOnBorder(sourcePos.x, sourcePos.y, targetPos.x, targetPos.y, edge.sourceAnchor);
    const targetPoint = getPointOnBorder(targetPos.x, targetPos.y, sourcePos.x, sourcePos.y, edge.targetAnchor);
    
    const sx = sourcePoint.x;
    const sy = sourcePoint.y;
    const tx = targetPoint.x;
    const ty = targetPoint.y;

    // Calculate Control Point for Quadratic Bezier
    // Base is midpoint
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;

    const cx = mx + (edge.controlPointOffset?.x ?? 0);
    const cy = my + (edge.controlPointOffset?.y ?? 0);

    const pathD = `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;

    // Midpoint for label (Quadratic Bezier t=0.5)
    // x = (1-t)^2*sx + 2*(1-t)*t*cx + t^2*tx
    const t = 0.5;
    const mt = 1 - t;
    const lx = mt * mt * sx + 2 * mt * t * cx + t * t * tx;
    const ly = mt * mt * sy + 2 * mt * t * cy + t * t * ty;

    // Determine if directed (arrow)
    const isDirected = (edge as any).isDirected !== false; // Default true

    return (
        <g
            className={`group cursor-pointer ${isSelected ? 'opacity-100' : 'opacity-80 hover:opacity-100'}`}
            onClick={(e) => {
                e.stopPropagation();
                onSelect(edge.id);
            }}
        >
            {/* Invisible thick path for easier clicking */}
            <path
                d={pathD}
                stroke="transparent"
                strokeWidth="20"
                fill="none"
            />

            {/* Visible Path */}
            <path
                d={pathD}
                fill="none"
                markerEnd={isDirected ? `url(#${customMarkerId || (isSelected ? 'arrowhead-selected' : 'arrowhead-default')})` : undefined}
                className="transition-colors duration-200"
                stroke={isStorylineEdge ? (style?.stroke as string || '#94a3b8') : (isSelected ? '#3b82f6' : '#94a3b8')}
                strokeWidth={isStorylineEdge ? (style?.strokeWidth as number || 5) : (isSelected ? 3 : 2)}
                opacity={style?.opacity}
                strokeDasharray={style?.strokeDasharray as string}
                style={{ filter: style?.filter as string }}
            />

            {/* Control Handle (Middle) - Only if selected or hovering? Let's show if selected */}
            {isSelected && onControlMouseDown && (
                <circle
                    cx={cx}
                    cy={cy}
                    r={6}
                    fill="#3b82f6"
                    stroke="white"
                    strokeWidth={2}
                    className="cursor-grab active:cursor-grabbing"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        onControlMouseDown(e, edge.id);
                    }}
                />
            )}

            {/* Anchor Handles - Only if selected */}
            {isSelected && onAnchorMouseDown && (
                <>
                    <circle
                        cx={sx}
                        cy={sy}
                        r={4}
                        fill="white"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onAnchorMouseDown(e, edge.id, 'source');
                        }}
                    />
                    <circle
                        cx={tx}
                        cy={ty}
                        r={4}
                        fill="white"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onAnchorMouseDown(e, edge.id, 'target');
                        }}
                    />
                </>
            )}

            {/* Label */}
            {edge.label && !edge.id.startsWith('storyline-') && (
                <foreignObject x={lx - 50} y={ly - 12} width="100" height="24" style={{ overflow: 'visible' }}>
                    <div className="flex justify-center items-center">
                        <span className={`px-2 py-0.5 text-[10px] rounded-full border shadow-sm truncate max-w-full ${isSelected ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                            {edge.label}
                        </span>
                    </div>
                </foreignObject>
            )}
        </g>
    );
});

GraphEdge.displayName = 'GraphEdge';
