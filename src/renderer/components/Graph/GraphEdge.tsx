import { memo } from 'react';
import { BookNodeEdge } from '../../domain/book_node';
import { BookNodePosition } from '../../domain/book_node';

interface GraphEdgeProps {
    edge: BookNodeEdge;
    sourcePos: BookNodePosition;
    targetPos: BookNodePosition;
    isSelected: boolean;
    onSelect: (id: string) => void;
    style?: React.CSSProperties; // Add style prop
    onControlMouseDown?: (e: React.MouseEvent, edgeId: string) => void;
    onAnchorMouseDown?: (e: React.MouseEvent, edgeId: string, type: 'source' | 'target') => void;
}

export const GraphEdge = memo(({ edge, sourcePos, targetPos, isSelected, onSelect, style, onControlMouseDown, onAnchorMouseDown }: GraphEdgeProps) => {
    if (!sourcePos.x || !sourcePos.y || !targetPos.x || !targetPos.y) return null;

    // Resolve Anchors (relative to node center/top-left? Let's assume relative to node Position provided in props)
    // sourcePos/targetPos passed here are usually the node positions (top-left or center depending on GraphView logic)
    // GraphView passed: { x: pos.x, y: pos.y }. Assuming node positions are center-based or top-left.
    // GraphNode renders with `transform: translate(-50%, -50%)`, so position is CENTER.

    // Anchors in `edge` are offsets from the node position.
    const sx = sourcePos.x + (edge.sourceAnchor?.x ?? 0);
    const sy = sourcePos.y + (edge.sourceAnchor?.y ?? 0);
    const tx = targetPos.x + (edge.targetAnchor?.x ?? 0);
    const ty = targetPos.y + (edge.targetAnchor?.y ?? 0);

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
                stroke={isSelected ? '#3b82f6' : '#94a3b8'}
                strokeWidth={isSelected ? 3 : 2}
                fill="none"
                markerEnd={isDirected ? `url(#arrowhead-${isSelected ? 'selected' : 'default'})` : undefined}
                className="transition-colors duration-200"
                style={style} // Apply custom style
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
            {edge.label && (
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
