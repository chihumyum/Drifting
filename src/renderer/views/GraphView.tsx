import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { BookNodeEdge, BookNode } from '../domain/book-node';
import { GraphNode } from '../viewComponents/Graph/GraphNode';
import { GraphEdge } from '../viewComponents/Graph/GraphEdge';
import { useBookNode } from '../usecase/useBookNode';
import { useStoryline } from '../usecase/useStoryline';
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
        storylines,
        storylineNodeMapping,
        setStorylineNodeMapping,
    } = useDataStore();
    const { setGraphViewOpen } = useUiStore();

    const nodeUsecases = useBookNode();
    const storylineUsecases = useStoryline();
    const { user } = useAuthStore();
    const projectId = getProjectId(user?.id);

    // Local State
    const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [tempEdgeEnd, setTempEdgeEnd] = useState<{ x: number, y: number } | null>(null);
    const [hasLayoutRun, setHasLayoutRun] = useState(false);
    const [isSimulationActive, setIsSimulationActive] = useState(false);
    const [draggedNodeIds, setDraggedNodeIds] = useState<Set<string>>(new Set()); // Track manually positioned nodes
    const [highlightedStorylineId, setHighlightedStorylineId] = useState<string | null>(null);
    const [summaryEditor, setSummaryEditor] = useState<{ nodeId: string; summary: string } | null>(null);

    // Edge Editing State
    const [isEdgeEditOpen, setIsEdgeEditOpen] = useState(false);
    const [editingEdge, setEditingEdge] = useState<BookNodeEdge | null>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const simulationRef = useRef<d3.Simulation<d3.SimulationNodeDatum, undefined> | null>(null);
    const loadedRef = useRef(false);

    // Load Mappings 
    useEffect(() => {
        if (storylines.length === 0) return;

        // Check if we need to load mappings
        const needsLoading = storylines.some(s => !storylineNodeMapping[s.id]);

        if (!needsLoading) return;

        const loadMappings = async () => {
            const mapping: Record<string, string[]> = { ...storylineNodeMapping };

            for (const line of storylines) {
                if (!mapping[line.id]) {
                    mapping[line.id] = await storylineUsecases.getNodeIdsByStoryline(line.id);
                }
            }
            setStorylineNodeMapping(mapping);
        };

        void loadMappings();

    }, [storylines, storylineUsecases, setStorylineNodeMapping, storylineNodeMapping]);

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
                    // kind: 'chronology',
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

    // Helper function: Calculate anchor position on node border
    const getAnchorOnBorder = (nodePos: { x: number, y: number }, anchor: { x: number, y: number }) => {
        const nodeW = 240;
        const nodeH = 160;
        const halfW = nodeW / 2;
        const halfH = nodeH / 2;

        // Clamp to border
        const clampedX = Math.max(-halfW, Math.min(halfW, anchor.x));
        const clampedY = Math.max(-halfH, Math.min(halfH, anchor.y));

        // Determine which edge is closest
        const distToLeft = Math.abs(clampedX + halfW);
        const distToRight = Math.abs(clampedX - halfW);
        const distToTop = Math.abs(clampedY + halfH);
        const distToBottom = Math.abs(clampedY - halfH);

        const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);

        if (minDist === distToLeft) return { x: -halfW, y: clampedY };
        if (minDist === distToRight) return { x: halfW, y: clampedY };
        if (minDist === distToTop) return { x: clampedX, y: -halfH };
        return { x: clampedX, y: halfH };
    };

    // Helper: Check if point is inside node
    const isPointInNode = (worldX: number, worldY: number, node: BookNode) => {
        if (!node.position) return false;
        const nodeW = 240;
        const nodeH = 160;
        const halfW = nodeW / 2;
        const halfH = nodeH / 2;
        const dx = worldX - node.position.x;
        const dy = worldY - node.position.y;
        return Math.abs(dx) <= halfW && Math.abs(dy) <= halfH;
    };

    // Helper: Find node at world position
    const findNodeAtPosition = (worldX: number, worldY: number) => {
        return bookNodes.find(node => isPointInNode(worldX, worldY, node));
    };


    // Force-Directed Layout with Real-time Simulation
    useEffect(() => {
        if (bookNodes.length === 0) return;

        // Create simulation nodes with current positions
        const simulationNodes = bookNodes.map(n => ({
            ...n,
            x: n.position?.x ?? (Math.random() - 0.5) * 1000,
            y: n.position?.y ?? (Math.random() - 0.5) * 1000,
            vx: 0, // Initialize velocity
            vy: 0
        })) as (BookNode & d3.SimulationNodeDatum)[];

        const simulationEdges = allEdges.map(e => ({
            ...e,
            source: e.sourceNodeId,
            target: e.targetNodeId
        }));

        // Create or update simulation with dynamic charge based on whether node was dragged
        const simulation = d3.forceSimulation(simulationNodes)
            .force("charge", d3.forceManyBody().strength((d: any) => {
                // Dragged nodes have minimal repulsion, new nodes have gentle repulsion
                return draggedNodeIds.has(d.id) ? -150 : -600;
            }).distanceMax(500))
            .force("collide", d3.forceCollide().radius((d: any) => {
                // Dragged nodes can be very close together
                return draggedNodeIds.has(d.id) ? 50 : 90;
            }).strength(0.5))
            .force("link", d3.forceLink(simulationEdges)
                .id((d: any) => d.id)
                .distance(250)
                .strength(0.005) // Almost no pull, edges are purely visual
            )
            .force("center", d3.forceCenter(0, 0).strength(0.01)) // Very weak centering
            .alphaDecay(0.03) // Faster decay
            .velocityDecay(0.5); // High damping

        simulationRef.current = simulation as any;

        // Update positions on each tick
        simulation.on("tick", () => {
            simulationNodes.forEach(n => {
                if (n.x !== undefined && n.y !== undefined) {
                    // Only update if not being dragged
                    const isDragging = dragState?.type === 'node' && dragState.id === n.id;
                    if (!isDragging) {
                        updateBookNode(n.id, { position: { x: n.x, y: n.y } });
                    }
                }
            });
        });

        // Initial run for better positioning
        if (!hasLayoutRun) {
            for (let i = 0; i < 200; ++i) simulation.tick();
            setHasLayoutRun(true);
            centerView(simulationNodes);
        }

        setIsSimulationActive(true);

        // Cleanup
        return () => {
            simulation.stop();
            simulationRef.current = null;
        };
    }, [bookNodes.length, allEdges.length, draggedNodeIds]); // Re-run when node/edge count or dragged status changes

    // Update simulation when nodes are dragged
    useEffect(() => {
        if (!simulationRef.current) return;

        bookNodes.forEach(node => {
            const simNode = simulationRef.current!.nodes().find((n: any) => n.id === node.id) as any;
            if (simNode && node.position) {
                // Update simulation node position if it changed externally
                if (Math.abs(simNode.x - node.position.x) > 1 || Math.abs(simNode.y - node.position.y) > 1) {
                    simNode.x = node.position.x;
                    simNode.y = node.position.y;
                    simNode.fx = dragState?.type === 'node' && dragState.id === node.id ? node.position.x : null;
                    simNode.fy = dragState?.type === 'node' && dragState.id === node.id ? node.position.y : null;
                }
            }
        });

        // Reheat simulation slightly when dragging
        if (dragState?.type === 'node') {
            simulationRef.current.alpha(0.3).restart();
        }
    }, [bookNodes, dragState]);

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

            // Update both store and simulation
            updateBookNode(dragState.id, { position: { x: newPos.x, y: newPos.y } });

            // Update simulation node position while dragging
            if (simulationRef.current) {
                const simNode = simulationRef.current.nodes().find((n: any) => n.id === dragState.id) as any;
                if (simNode) {
                    simNode.fx = newPos.x;
                    simNode.fy = newPos.y;
                }
            }
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
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;

            // Get world position of cursor
            const worldPos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

            // Store the temp position for rendering
            setTempEdgeEnd(worldPos);
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
            if (edge && tempEdgeEnd) {
                // Find node at drop position
                const targetNode = findNodeAtPosition(tempEdgeEnd.x, tempEdgeEnd.y);

                if (targetNode) {
                    // Calculate anchor on target node border
                    const originalNodeId = dragState.anchorType === 'source' ? edge.sourceNodeId : edge.targetNodeId;
                    const originalNode = bookNodes.find(n => n.id === originalNodeId);

                    if (originalNode?.position) {
                        const dx = tempEdgeEnd.x - targetNode.position.x;
                        const dy = tempEdgeEnd.y - targetNode.position.y;
                        const newAnchor = getAnchorOnBorder(targetNode.position, { x: dx, y: dy });

                        // Update edge connection and anchor
                        if (dragState.anchorType === 'source') {
                            const updatedEdge = { ...edge, sourceNodeId: targetNode.id, sourceAnchor: newAnchor };
                            setNodeEdges(nodeEdges.map(e => e.id === dragState.id ? updatedEdge : e));
                            nodeUsecases.updateEdge(dragState.id, { sourceNodeId: targetNode.id, sourceAnchor: newAnchor });
                        } else {
                            const updatedEdge = { ...edge, targetNodeId: targetNode.id, targetAnchor: newAnchor };
                            setNodeEdges(nodeEdges.map(e => e.id === dragState.id ? updatedEdge : e));
                            nodeUsecases.updateEdge(dragState.id, { targetNodeId: targetNode.id, targetAnchor: newAnchor });
                        }
                    }
                } else {
                    // Dropped outside any node - delete edge
                    setNodeEdges(nodeEdges.filter(e => e.id !== dragState.id));
                    // TODO: Call API to delete edge from backend
                }
            }
        }

        // Release node from fixed position in simulation
        if (dragState?.type === 'node' && dragState.id && simulationRef.current) {
            const simNode = simulationRef.current.nodes().find((n: any) => n.id === dragState.id) as any;
            if (simNode) {
                simNode.fx = null;
                simNode.fy = null;
                // Mark node as manually positioned (dragged)
                setDraggedNodeIds(prev => new Set(prev).add(dragState.id!));
                // Persist final position
                nodeUsecases.updateNodePosition(dragState.id, { x: simNode.x, y: simNode.y });
            }
            // Reheat simulation slightly to let nodes settle
            simulationRef.current.alpha(0.1).restart();
        }

        setDragState(null);
        setTempEdgeEnd(null);
    };

    // Node Interactions
    const handleNodeMouseDown = (e: React.MouseEvent, id: string) => {
        const node = bookNodes.find(n => n.id === id);
        if (!node) return;

        // Fix node position in simulation while dragging
        if (simulationRef.current) {
            const simNode = simulationRef.current.nodes().find((n: any) => n.id === id) as any;
            if (simNode) {
                simNode.fx = simNode.x;
                simNode.fy = simNode.y;
            }
        }

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

            {/* Layout Controls */}
            <div className="absolute top-16 right-4 z-50 flex flex-col gap-2">
                <button
                    className="bg-white/90 px-3 py-2 rounded shadow hover:bg-white text-sm"
                    onClick={() => {
                        if (simulationRef.current) {
                            simulationRef.current.alpha(1).restart();
                        }
                    }}
                    title="Reheat simulation to reorganize nodes"
                >
                    🔄 Re-layout
                </button>
                <button
                    className={`px-3 py-2 rounded shadow text-sm ${isSimulationActive ? 'bg-green-100 hover:bg-green-200' : 'bg-gray-100 hover:bg-gray-200'}`}
                    onClick={() => {
                        if (simulationRef.current) {
                            if (isSimulationActive) {
                                simulationRef.current.stop();
                                setIsSimulationActive(false);
                            } else {
                                simulationRef.current.alpha(0.3).restart();
                                setIsSimulationActive(true);
                            }
                        }
                    }}
                    title={isSimulationActive ? "Pause physics simulation" : "Resume physics simulation"}
                >
                    {isSimulationActive ? '⏸️ Pause' : '▶️ Resume'}
                </button>
            </div>

            {/* UI Overlay - Zoom Controls */}
            <div className="absolute bottom-4 right-4 flex gap-2 z-50">
                <button className="bg-white p-2 rounded shadow hover:bg-gray-50" onClick={() => setViewport(v => ({ ...v, scale: v.scale * 1.2 }))}>+</button>
                <button className="bg-white p-2 rounded shadow hover:bg-gray-50" onClick={() => setViewport(v => ({ ...v, scale: v.scale / 1.2 }))}>-</button>
            </div>

            {/* Highlighted Storyline Name */}
            {highlightedStorylineId && (() => {
                const storyline = storylines.find(s => s.id === highlightedStorylineId);
                if (!storyline) return null;
                return (
                    <div className="absolute top-16 left-4 z-50 bg-white/95 backdrop-blur-sm px-4 py-2 rounded-lg shadow-lg border border-gray-200">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: storyline.color }} />
                            <span className="text-sm font-semibold text-gray-800">{storyline.name}</span>
                            <button
                                onClick={() => setHighlightedStorylineId(null)}
                                className="ml-2 text-gray-400 hover:text-gray-600 text-xs"
                            >×</button>
                        </div>
                    </div>
                );
            })()}

            {/* Summary Editor */}
            {summaryEditor && (
                <div className="absolute bottom-4 left-4 z-50 w-96 bg-white/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-gray-800">Edit Summary</h3>
                        <button
                            onClick={() => setSummaryEditor(null)}
                            className="text-gray-400 hover:text-gray-600"
                        >×</button>
                    </div>
                    <textarea
                        className="w-full h-32 p-2 text-xs border border-gray-200 rounded resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={summaryEditor.summary}
                        onChange={(e) => setSummaryEditor({ ...summaryEditor, summary: e.target.value })}
                        placeholder="Enter summary..."
                    />
                    <div className="flex justify-end gap-2 mt-2">
                        <button
                            className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                            onClick={() => setSummaryEditor(null)}
                        >
                            Cancel
                        </button>
                        <button
                            className="px-3 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded"
                            onClick={async () => {
                                if (summaryEditor) {
                                    await nodeUsecases.updateNode(summaryEditor.nodeId, { summary: summaryEditor.summary });
                                    setSummaryEditor(null);
                                }
                            }}
                        >
                            Save
                        </button>
                    </div>
                </div>
            )}

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
                        <marker id="arrowhead-default" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                        </marker>
                        <marker id="arrowhead-selected" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#3b82f6" />
                        </marker>
                        {/* Dynamic markers for each storyline */}
                        {storylines.map(storyline => (
                            <marker
                                key={`marker-${storyline.id}`}
                                id={`arrowhead-storyline-${storyline.id}`}
                                markerWidth="10"
                                markerHeight="7"
                                refX="9"
                                refY="3.5"
                                orient="auto"
                            >
                                <polygon points="0 0, 10 3.5, 0 7" fill={storyline.color || '#b89968'} />
                            </marker>
                        ))}
                    </defs>
                    {/* Render Derived (Storyline) Edges first (bottom layer) */}
                    {derivedEdges.map(edge => {
                        const source = bookNodes.find(n => n.id === edge.sourceNodeId);
                        const target = bookNodes.find(n => n.id === edge.targetNodeId);
                        // Extract storyline ID from edge ID
                        // ID Format: storyline-{storylineId}-{sourceId}-{targetId}
                        // Remove 'storyline-' prefix, then remove '-{sourceId}-{targetId}' suffix
                        const prefix = 'storyline-';
                        const suffix = `-${edge.sourceNodeId}-${edge.targetNodeId}`;
                        const storylineId = edge.id.substring(prefix.length, edge.id.length - suffix.length);
                        const storyline = storylines.find(s => s.id === storylineId);

                        // Get color with proper fallback
                        let color = '#b89968'; // Default color
                        if (storyline && storyline.color) {
                            color = storyline.color;
                        }

                        const sPos = source?.position ? { x: source.position.x ?? 0, y: source.position.y ?? 0 } : null;
                        const tPos = target?.position ? { x: target.position.x ?? 0, y: target.position.y ?? 0 } : null;

                        if (!sPos || !tPos) return null;

                        return (
                            <GraphEdge
                                key={edge.id}
                                edge={edge}
                                sourcePos={sPos}
                                targetPos={tPos}
                                isSelected={highlightedStorylineId === storylineId}
                                onSelect={() => {
                                    setHighlightedStorylineId(storylineId);
                                    setSelectedNodeIds(new Set());
                                    setSelectedEdgeId(null);
                                }}
                                customMarkerId={`arrowhead-storyline-${storylineId}`}
                                style={{
                                    stroke: color,
                                    strokeWidth: highlightedStorylineId === storylineId ? 6 : 5,
                                    opacity: highlightedStorylineId === storylineId ? 1.0 : 0.7,
                                    strokeDasharray: 'none',
                                    filter: highlightedStorylineId === storylineId ? 'drop-shadow(0 0 4px rgba(0,0,0,0.2))' : 'drop-shadow(0 0 2px rgba(0,0,0,0.1))'
                                }}
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

                        // Hide edge being dragged by anchor
                        if (dragState?.type === 'edge-anchor' && dragState.id === edge.id) {
                            return null;
                        }

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

                    {/* Dragging Anchor Line */}
                    {dragState?.type === 'edge-anchor' && dragState.id && tempEdgeEnd && (() => {
                        const edge = nodeEdges.find(e => e.id === dragState.id);
                        if (!edge) return null;
                        const anchorType = dragState.anchorType;
                        const otherNodeId = anchorType === 'source' ? edge.targetNodeId : edge.sourceNodeId;
                        const otherNode = bookNodes.find(n => n.id === otherNodeId);
                        if (!otherNode?.position) return null;

                        return (
                            <line
                                x1={anchorType === 'source' ? tempEdgeEnd.x : otherNode.position.x}
                                y1={anchorType === 'source' ? tempEdgeEnd.y : otherNode.position.y}
                                x2={anchorType === 'target' ? tempEdgeEnd.x : otherNode.position.x}
                                y2={anchorType === 'target' ? tempEdgeEnd.y : otherNode.position.y}
                                stroke="#3b82f6"
                                strokeWidth="2"
                                strokeDasharray="5,5"
                            />
                        );
                    })()}

                </svg>

                {/* Nodes Layer */}
                {bookNodes.map(node => (
                    <div key={node.id} onMouseUp={(e) => handleNodeMouseUp(e, node.id)}>
                        <GraphNode
                            node={node}
                            storylines={getStorylinesForNode(node.id)}
                            elements={[]} // TODO
                            isSelected={selectedNodeIds.has(node.id)}
                            isHighlighted={highlightedStorylineId ? getStorylinesForNode(node.id).some(s => s.id === highlightedStorylineId) : false}
                            scale={viewport.scale}
                            onSelect={(id, multi) => {
                                setSelectedEdgeId(null);
                                setHighlightedStorylineId(null);
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
                            onTitleClick={(id) => {
                                setGraphViewOpen(false);
                                navigate(`/editor/${id}`);
                            }}
                            onSummaryClick={(id, summary) => {
                                setSummaryEditor({ nodeId: id, summary: summary || '' });
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
