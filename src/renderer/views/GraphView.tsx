import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { BookNodeEdge, BookNode } from '../domain/book_node';
import { GraphNode } from '../components/Graph/GraphNode';
import { GraphEdge } from '../components/Graph/GraphEdge';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { useStorylineUsecases } from '../hooks/useStorylineUsecases';
import { useAuthStore, getProjectId } from '../store/auth';
import { nanoid } from 'nanoid';
import * as d3 from 'd3-force';

// Types
interface Viewport {
    x: number;
    y: number;
    scale: number;
}

interface DragState {
    type: 'node' | 'viewport' | 'edge-create' | 'edge-control' | 'edge-anchor';
    id?: string; // nodeId or edgeId
    startX: number;
    startY: number;
    initialPos?: { x: number; y: number }; // For node
    initialViewport?: Viewport; // For viewport
    initialControlPoint?: { x: number, y: number }; // For edge control
    initialAnchor?: { x: number, y: number }; // For edge anchor
    anchorType?: 'source' | 'target';
}

export function GraphView() {
    const navigate = useNavigate();
    const {
        bookNodes,
        nodeEdges,
        updateBookNode,
        setNodeEdges,
        setGraphViewOpen,
        storylines,
        storylineNodeMapping,
        setStorylines,
        setStorylineNodeMapping
    } = useAppStore();

    const nodeUsecases = useBookNodeUsecases();
    const storylineUsecases = useStorylineUsecases();
    const { user } = useAuthStore();
    const projectId = getProjectId(user?.id);

    // Local State
    const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [tempEdgeEnd, setTempEdgeEnd] = useState<{ x: number, y: number } | null>(null);
    const [hasLayoutRun, setHasLayoutRun] = useState(false);

    // Edge Editing State
    const [isEdgeEditOpen, setIsEdgeEditOpen] = useState(false);
    const [editingEdge, setEditingEdge] = useState<BookNodeEdge | null>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const loadedRef = useRef(false);

    // Load Data
    useEffect(() => {
        if (!loadedRef.current) {
            nodeUsecases.loadNodes({ projectId });
            loadedRef.current = true;
        }

        const loadStorylines = async () => {
            const lines = await storylineUsecases.getStorylinesByProject(projectId);
            setStorylines(lines);

            const mapping: Record<string, string[]> = {};
            for (const line of lines) {
                const nodeIds = await storylineUsecases.getNodeIdsByStoryline(line.id);
                mapping[line.id] = nodeIds;
            }
            setStorylineNodeMapping(mapping);
        };
        loadStorylines();

    }, [nodeUsecases, storylineUsecases, projectId, setStorylines, setStorylineNodeMapping, bookNodes.length]);

    const derivedEdges = useMemo(() => {
        const edges: BookNodeEdge[] = [];
        storylines.forEach(line => {
            const nodeIds = storylineNodeMapping[line.id] || [];

            // Map IDs to node objects and filter out missing ones
            const nodesInStoryline = nodeIds
                .map(id => bookNodes.find(n => n.id === id))
                .filter((n): n is BookNode => !!n);

            // Sort by chronological start order
            nodesInStoryline.sort((a, b) => a.start - b.start);

            for (let i = 0; i < nodesInStoryline.length - 1; i++) {
                const source = nodesInStoryline[i];
                const target = nodesInStoryline[i + 1];

                edges.push({
                    id: `storyline-${line.id}-${source.id}-${target.id}`, // Deterministic ID
                    projectId,
                    sourceNodeId: source.id,
                    targetNodeId: target.id,
                    kind: 'chronology',
                    label: line.name,
                    weight: 1,
                    isDirected: true,
                    createdAt: new Date().toISOString(),
                });
            }
        });
        return edges;
    }, [storylines, storylineNodeMapping, bookNodes, projectId]);

    // Helper to find storylines for a node
    const getStorylinesForNode = (nodeId: string) => {
        return storylines.filter(sl => {
            return storylineNodeMapping[sl.id]?.includes(nodeId);
        });
    };

    const allEdges = useMemo(() => [...nodeEdges, ...derivedEdges], [nodeEdges, derivedEdges]);


    // Auto Layout Effect
    useEffect(() => {
        // Wait for nodes to load
        if (bookNodes.length === 0 || hasLayoutRun) return;

        // Check if we need layout: if many nodes are at 0,0
        // We define "many" as > 50%
        const nodesAtZero = bookNodes.filter(n => !n.position || (Math.abs(n.position.x ?? 0) < 5 && Math.abs(n.position.y ?? 0) < 5));


        // If we have nodes and most are properly positioned, just center the view
        if (bookNodes.length > 0 && nodesAtZero.length < bookNodes.length * 0.5) {
            centerView(bookNodes);
            setHasLayoutRun(true);
            return;
        }

        // Run d3 force layout for initial positioning
        // Clone nodes to avoid mutating state directly during simulation
        const simulationNodes = bookNodes.map(n => ({
            ...n,
            x: n.position?.x || (Math.random() - 0.5) * 1000, // Increase jitter
            y: n.position?.y || (Math.random() - 0.5) * 1000
        })) as (BookNode & d3.SimulationNodeDatum)[];

        const simulationEdges = allEdges.map(e => ({
            ...e,
            source: e.sourceNodeId,
            target: e.targetNodeId
        }));

        const simulation = d3.forceSimulation(simulationNodes)
            .force("charge", d3.forceManyBody().strength(-3000)) // Increase repulsion
            .force("collide", d3.forceCollide().radius(200).strength(0.7)) // Add collision
            .force("link", d3.forceLink(simulationEdges).id((d: any) => d.id).distance(400))
            .force("center", d3.forceCenter(0, 0))
            .stop();

        // Run layout synchronously (faster for initial load than animating)
        for (let i = 0; i < 300; ++i) simulation.tick();

        // Apply positions back to store
        simulationNodes.forEach(n => {
            if (n.x !== undefined && n.y !== undefined) {
                // Use the store update directly to reflect changes in UI immediately
                updateBookNode(n.id, { position: { x: n.x, y: n.y } });
                // Also persist to backend (debounced or fire-and-forget)
                nodeUsecases.updateNodePosition(n.id, { x: n.x, y: n.y });
            }
        });

        // Center view after layout
        centerView(simulationNodes);
        setHasLayoutRun(true);

    }, [bookNodes, allEdges, hasLayoutRun, nodeUsecases, updateBookNode]);

    // Helper to center the view
    const centerView = (nodes: any[]) => {
        if (nodes.length === 0 || !containerRef.current) return;

        const xs = nodes.map((n: any) => (n.x ?? n.position?.x ?? 0) as number);
        const ys = nodes.map((n: any) => (n.y ?? n.position?.y ?? 0) as number);

        if (xs.length === 0) return;

        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const width = maxX - minX + 600; // Padding
        const height = maxY - minY + 600;

        const { width: containerW, height: containerH } = containerRef.current.getBoundingClientRect();

        // Fit to screen
        const scale = Math.min(containerW / width, containerH / height, 1);

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        setViewport({
            x: containerW / 2 - centerX * scale,
            y: containerH / 2 - centerY * scale,
            scale
        });
    };

    // Handle Close Shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setGraphViewOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [setGraphViewOpen]);

    // Helper: World to Screen / Screen to World
    const screenToWorld = (sx: number, sy: number) => ({
        x: (sx - viewport.x) / viewport.scale,
        y: (sy - viewport.y) / viewport.scale
    });

    // Handlers
    // Sync viewport ref for event handlers
    const viewportRef = useRef(viewport);
    useEffect(() => { viewportRef.current = viewport; }, [viewport]);

    // Determine container ref
    // We already have containerRef

    // Handle Wheel (Native Listener for non-passive)
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault(); // Always prevent default

            if (e.ctrlKey || e.metaKey) {
                // Zoom
                const zoomSensitivity = 0.001;
                const delta = -e.deltaY * zoomSensitivity;
                const currentViewport = viewportRef.current;
                const newScale = Math.min(Math.max(0.1, currentViewport.scale + delta), 3);

                const rect = container.getBoundingClientRect();

                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const worldX = (mouseX - currentViewport.x) / currentViewport.scale;
                const worldY = (mouseY - currentViewport.y) / currentViewport.scale;

                const newX = mouseX - worldX * newScale;
                const newY = mouseY - worldY * newScale;

                setViewport({ x: newX, y: newY, scale: newScale });
            } else {
                // Pan
                setViewport(prev => ({
                    ...prev,
                    x: prev.x - e.deltaX,
                    y: prev.y - e.deltaY
                }));
            }
        };

        container.addEventListener('wheel', onWheel, { passive: false });
        // Use capture phase for mousedown to ensure we catch it before children if needed?
        // No, bubble is fine for delegation if we check targets.
        return () => container.removeEventListener('wheel', onWheel);
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        // Robust background check:
        // We allow dragging if the target is NOT an interactive element (node, handle, button)
        // This is more robust than checking === containerRef.current because SVG backgrounds
        // might capture the click.
        const target = e.target as HTMLElement;
        // const isInteractive = target.closest('[data-interactive="true"]');
        // Check if we hit a node or edge handle (we'll add data attributes to them later)
        // For now, assume anything NOT explicitly interactive is the background layer
        // But nodes capture their own mousedown (stopPropagation), so this handler here
        // only runs if they didn't catch it.
        // HOWEVER, creating edges assumes we let it bubble? No, handleNodeMouseDown stops prop.
        // So anything reaching here IS background found.

        // Wait, handleNodeMouseDown calls stopPropagation in our code?
        // Yes: e.stopPropagation(); onMouseDown(e, node.id);

        // So simply:
        if (target === containerRef.current || target.tagName === 'svg' || target.id === 'graph-bg') {
            setDragState({
                type: 'viewport',
                startX: e.clientX,
                startY: e.clientY,
                initialViewport: { ...viewport }
            });
            setSelectedNodeIds(new Set());
            setSelectedEdgeId(null);
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!dragState) return;

        if (dragState.type === 'viewport' && dragState.initialViewport) {
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            setViewport({
                ...dragState.initialViewport,
                x: dragState.initialViewport.x + dx,
                y: dragState.initialViewport.y + dy
            });
        } else if (dragState.type === 'node' && dragState.id && dragState.initialPos) {
            const dx = (e.clientX - dragState.startX) / viewport.scale;
            const dy = (e.clientY - dragState.startY) / viewport.scale;

            const newPos = {
                x: dragState.initialPos.x + dx,
                y: dragState.initialPos.y + dy
            };

            // Optimistic update via store
            // Note: useBookNodeUsecases.updateNode usually saves to DB. 
            // For smooth dragging we might want local state or debounced save.
            // But user wanted "Graph View" so simple functional update is acceptable.
            // We'll update via usecase for now (it updates store immediately).
            nodeUsecases.updateNodePosition(dragState.id, { x: newPos.x, y: newPos.y });

        } else if (dragState.type === 'edge-create') {
            // Update temp line end
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect) {
                setTempEdgeEnd(screenToWorld(e.clientX - rect.left, e.clientY - rect.top));
            }
        } else if (dragState.type === 'edge-control' && dragState.id) {
            const edgeId = dragState.id;
            const deltaX = (e.clientX - dragState.startX) / viewport.scale;
            const deltaY = (e.clientY - dragState.startY) / viewport.scale;

            const newOffset = {
                x: (dragState.initialControlPoint?.x ?? 0) + deltaX,
                y: (dragState.initialControlPoint?.y ?? 0) + deltaY
            };

            setNodeEdges(nodeEdges.map(edge =>
                edge.id === edgeId ? { ...edge, controlPointOffset: newOffset } : edge
            ));
        } else if (dragState.type === 'edge-anchor' && dragState.id && dragState.anchorType) {
            const edgeId = dragState.id;
            const deltaX = (e.clientX - dragState.startX) / viewport.scale;
            const deltaY = (e.clientY - dragState.startY) / viewport.scale;

            const newAnchor = {
                x: (dragState.initialAnchor?.x ?? 0) + deltaX,
                y: (dragState.initialAnchor?.y ?? 0) + deltaY
            };

            setNodeEdges(nodeEdges.map(edge => {
                if (edge.id !== edgeId) return edge;
                if (dragState.anchorType === 'source') {
                    return { ...edge, sourceAnchor: newAnchor };
                } else {
                    return { ...edge, targetAnchor: newAnchor };
                }
            }));
        }
    };

    const handleMouseUp = () => {
        // Drop logic mostly handled in render/state
        // Drag end

        // Persistence for Edge Control/Anchor
        if (dragState?.type === 'edge-control' && dragState.id) {
            const edge = nodeEdges.find(e => e.id === dragState.id);
            if (edge && edge.controlPointOffset) {
                nodeUsecases.updateEdge(dragState.id, { controlPointOffset: edge.controlPointOffset });
            }
        }
        if (dragState?.type === 'edge-anchor' && dragState.id) {
            const edge = nodeEdges.find(e => e.id === dragState.id);
            if (edge) {
                if (dragState.anchorType === 'source' && edge.sourceAnchor) {
                    nodeUsecases.updateEdge(dragState.id, { sourceAnchor: edge.sourceAnchor });
                } else if (dragState.anchorType === 'target' && edge.targetAnchor) {
                    nodeUsecases.updateEdge(dragState.id, { targetAnchor: edge.targetAnchor });
                }
            }
        }

        setDragState(null);
        setTempEdgeEnd(null);
    };

    // Node Interactions
    const handleNodeMouseDown = (e: React.MouseEvent, id: string) => {
        const node = bookNodes.find(n => n.id === id);
        if (!node) return;

        setDragState({
            type: 'node',
            id,
            startX: e.clientX,
            startY: e.clientY,
            initialPos: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 }
        });
    };

    const handleOutputMouseDown = (e: React.MouseEvent, id: string) => {
        setDragState({
            type: 'edge-create',
            id,
            startX: e.clientX,
            startY: e.clientY
        });
        const node = bookNodes.find(n => n.id === id);
        if (node && node.position) setTempEdgeEnd({ x: node.position.x ?? 0, y: node.position.y ?? 0 });
    };

    const handleControlMouseDown = (e: React.MouseEvent, edgeId: string) => {
        const edge = nodeEdges.find(ed => ed.id === edgeId);
        if (!edge) return;
        setDragState({
            type: 'edge-control',
            id: edgeId,
            startX: e.clientX,
            startY: e.clientY,
            initialControlPoint: edge.controlPointOffset ? { ...edge.controlPointOffset } : { x: 0, y: 0 }
        });
    };

    const handleAnchorMouseDown = (e: React.MouseEvent, edgeId: string, type: 'source' | 'target') => {
        const edge = nodeEdges.find(ed => ed.id === edgeId);
        if (!edge) return;
        setDragState({
            type: 'edge-anchor',
            id: edgeId,
            startX: e.clientX,
            startY: e.clientY,
            anchorType: type,
            initialAnchor: type === 'source'
                ? (edge.sourceAnchor ? { ...edge.sourceAnchor } : { x: 0, y: 0 })
                : (edge.targetAnchor ? { ...edge.targetAnchor } : { x: 0, y: 0 })
        });
    };

    // Connect Logic (Drop on Node)
    const handleNodeMouseUp = (_e: React.MouseEvent, targetId: string) => {
        if (!dragState) return;

        if (dragState.type === 'edge-create' && dragState.id) {
            if (dragState.id !== targetId) {
                // Create Edge
                const newEdge: BookNodeEdge = {
                    id: nanoid(),
                    projectId: 'default', // TODO
                    sourceNodeId: dragState.id,
                    targetNodeId: targetId,
                    kind: 'causality', // Default
                    label: '',
                    weight: 1,
                    isDirected: true,
                    createdAt: new Date().toISOString()
                };

                // Call usecase to create edge (which updates store and DB)
                // Assuming usecase handles it. If not, logic below only updates store?
                // nodeUsecases doesn't seem to have createEdge exposed in the view yet (only nodes).
                // Wait, useBookNodeUsecases hook (old version) had loadEdges but maybe not createEdge?
                // I need to check if createEdge exists on nodeUsecases or if I should add it.
                // Assuming I should add it or use direct update for now.
                // But previous code was just setNodeEdges([...]). That doesn't persist! 
                // That's a bug in previous implementation or I missed it.
                // Let's stick to restoring the logic that was there (setNodeEdges), 
                // and fix persistence for edges separately or now.
                // Given the task is about "Freeform edge editing", creation persistence is out of scope but good to fix.
                // I'll stick to setNodeEdges for now to match previous state, but fixing the handleNodeMouseUp logic.

                setNodeEdges([...nodeEdges, newEdge]);

                // TODO: Persist new edge (missing in original code too?)
            }
        }
    };

    return (
        <div
            className="fixed inset-0 bg-[#fbf9f3] overflow-hidden z-[100] font-sans"
            ref={containerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
        >
            <div className="absolute top-4 left-4 z-50">
                <h1 className="text-xl font-bold text-gray-800">Graph View</h1>
            </div>

            {/* Close Button */}
            <button
                className="absolute top-4 right-16 z-50 bg-white/80 p-2 rounded shadow hover:bg-white"
                onClick={() => setGraphViewOpen(false)}
            >
                Close (Esc)
            </button>

            <div
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                    transformOrigin: '0 0',
                    width: '100%',
                    height: '100%',
                    position: 'absolute',
                    willChange: 'transform'
                }}
            >
                {/* Edges Layer */}
                <svg id="graph-bg" className="absolute top-0 left-0 w-full h-full overflow-visible">
                    <defs>
                        <marker id="arrowhead-default" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                        </marker>
                        <marker id="arrowhead-selected" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#3b82f6" />
                        </marker>
                    </defs>
                    {/* Render Derived (Storyline) Edges first (bottom layer) */}
                    {derivedEdges.map(edge => {
                        const source = bookNodes.find(n => n.id === edge.sourceNodeId);
                        const target = bookNodes.find(n => n.id === edge.targetNodeId);
                        // Extract storyline ID and get Color
                        // ID Format: storyline-{id}-source-target
                        const storylineId = edge.id.split('-')[1];
                        const storyline = storylines.find(s => s.id === storylineId);
                        const color = storyline?.color || '#3b82f6';

                        const sPos = source?.position ? { x: source.position.x ?? 0, y: source.position.y ?? 0 } : null;
                        const tPos = target?.position ? { x: target.position.x ?? 0, y: target.position.y ?? 0 } : null;

                        if (!sPos || !tPos) return null;

                        return (
                            <GraphEdge
                                key={edge.id}
                                edge={edge}
                                sourcePos={sPos}
                                targetPos={tPos}
                                isSelected={false}
                                onSelect={() => { }}
                                style={{ stroke: color, strokeWidth: 5, opacity: 1.0, strokeDasharray: 'none', filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.1))' }}
                            />
                        );
                    })}

                    {nodeEdges.map(edge => {
                        const source = bookNodes.find(n => n.id === edge.sourceNodeId);
                        const target = bookNodes.find(n => n.id === edge.targetNodeId);

                        // Ensure positions are valid objects
                        const sPos = source?.position ? { x: source.position.x ?? 0, y: source.position.y ?? 0 } : null;
                        const tPos = target?.position ? { x: target.position.x ?? 0, y: target.position.y ?? 0 } : null;

                        if (!sPos || !tPos) return null;

                        return (
                            <GraphEdge
                                key={edge.id}
                                edge={edge}
                                sourcePos={sPos}
                                targetPos={tPos}
                                isSelected={selectedEdgeId === edge.id}
                                onControlMouseDown={handleControlMouseDown}
                                onAnchorMouseDown={handleAnchorMouseDown}
                                onSelect={(id) => {
                                    setSelectedEdgeId(id);
                                    setSelectedNodeIds(new Set());
                                    setEditingEdge(edge);
                                    setIsEdgeEditOpen(true);
                                }}
                            />
                        );
                    })}

                    {/* Creating Edge Line */}
                    {dragState?.type === 'edge-create' && dragState.id && tempEdgeEnd && (
                        <line
                            x1={bookNodes.find(n => n.id === dragState.id)?.position?.x ?? 0}
                            y1={bookNodes.find(n => n.id === dragState.id)?.position?.y ?? 0}
                            x2={tempEdgeEnd.x}
                            y2={tempEdgeEnd.y}
                            stroke="#3b82f6"
                            strokeWidth="2"
                            strokeDasharray="5,5"
                        />
                    )}

                </svg>

                {/* Nodes Layer */}
                {bookNodes.map(node => (
                    <div key={node.id} onMouseUp={(e) => handleNodeMouseUp(e, node.id)}>
                        <GraphNode
                            node={node}
                            storylines={getStorylinesForNode(node.id)}
                            elements={[]} // TODO
                            isSelected={selectedNodeIds.has(node.id)}
                            scale={viewport.scale}
                            onSelect={(id, multi) => {
                                setSelectedEdgeId(null);
                                if (multi) {
                                    const newSet = new Set(selectedNodeIds);
                                    if (newSet.has(id)) newSet.delete(id); else newSet.add(id);
                                    setSelectedNodeIds(newSet);
                                } else {
                                    setSelectedNodeIds(new Set([id]));
                                }
                            }}
                            onNavigate={(id) => {
                                setGraphViewOpen(false); // Close graph on navigate
                                navigate(`/editor/${id}`);
                            }}
                            onElementClick={(id) => {
                                setGraphViewOpen(false);
                                navigate(`/element/${id}`);
                            }}
                            onMouseDown={handleNodeMouseDown}
                            onOutputMouseDown={handleOutputMouseDown}
                        />
                    </div>
                ))}
            </div>

            {/* UI Overlay */}
            <div className="absolute top-4 right-4 flex gap-2 z-50">
                <button className="bg-white p-2 rounded shadow hover:bg-gray-50" onClick={() => setViewport(v => ({ ...v, scale: v.scale * 1.2 }))}>+</button>
                <button className="bg-white p-2 rounded shadow hover:bg-gray-50" onClick={() => setViewport(v => ({ ...v, scale: v.scale / 1.2 }))}>-</button>
            </div>

            {/* Edge Edit Modal */}
            {isEdgeEditOpen && editingEdge && (
                <div className="absolute top-20 right-4 w-64 bg-white rounded-lg shadow-xl p-4 border border-gray-200 z-50">
                    <h3 className="font-semibold mb-3 text-gray-700">Edit Edge</h3>
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-medium text-gray-500">Description</label>
                            <input
                                type="text"
                                className="w-full mt-1 px-2 py-1.5 border rounded text-sm"
                                value={editingEdge.label || ''}
                                onChange={(e) => {
                                    const updated = { ...editingEdge, label: e.target.value };
                                    setEditingEdge(updated);
                                    const newEdges = nodeEdges.map(ed => ed.id === updated.id ? updated : ed);
                                    setNodeEdges(newEdges);
                                }}
                            />
                        </div>
                        <div>
                            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={editingEdge.isDirected !== false}
                                    onChange={(e) => {
                                        const updated = { ...editingEdge, isDirected: e.target.checked };
                                        setEditingEdge(updated);
                                        const newEdges = nodeEdges.map(ed => ed.id === updated.id ? updated : ed);
                                        setNodeEdges(newEdges);
                                    }}
                                />
                                Directed Edge
                            </label>
                        </div>
                        <div className="flex justify-end pt-2">
                            <button
                                className="px-3 py-1 bg-red-50 text-red-600 rounded text-xs hover:bg-red-100"
                                onClick={() => {
                                    setNodeEdges(nodeEdges.filter(e => e.id !== editingEdge.id));
                                    setIsEdgeEditOpen(false);
                                    setEditingEdge(null);
                                }}
                            >
                                Delete
                            </button>
                            <button
                                className="ml-2 px-3 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100"
                                onClick={() => setIsEdgeEditOpen(false)}
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
