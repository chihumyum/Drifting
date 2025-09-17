import { useCallback, useEffect, useState } from 'react';
import ReactFlow, { 
  Background, 
  Controls, 
  useNodesState, 
  useEdgesState,
  useReactFlow,
  ReactFlowProvider
} from 'reactflow';
import type {
  Connection,
  Edge,
  Node
} from 'reactflow';
import 'reactflow/dist/style.css';
import { query, run } from '../lib/db';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import type { StoryNode as StoryNodeType, NodeEdge, NodeType } from '../lib/schema';
import { StoryNode as StoryNodeComponent } from '../components/StoryNode';
import { ensureProjectId } from '../lib/codex';

interface StoryNodeData {
  label: string;
  type: StoryNodeType['type'];
  status: StoryNodeType['status'];
  summary?: string;
}

// Define nodeTypes outside component to prevent recreation on each render
const nodeTypes = {
  storyNode: StoryNodeComponent,
};

function GraphViewInner() {
  const { 
    setSelectedNodeId,
    addNode: addStoreNode,
    addEdge: addStoreEdge
  } = useAppStore();
  const [nodes, setNodes, onNodesChange] = useNodesState<StoryNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { } = useReactFlow();
  const [projectId, setProjectId] = useState<string | null>(null);

  const loadGraphData = useCallback(async () => {
    try {
      // Ensure we have a project id for DB-backed graph
      const pid = await ensureProjectId();
      setProjectId(pid);

      const sn = await query<StoryNodeType>(`SELECT * FROM story_node WHERE project_id='${pid}' ORDER BY order_key ASC`);
      const es = await query<NodeEdge>(`SELECT * FROM node_edge WHERE project_id='${pid}'`);

      const nodesRf: Node<StoryNodeData>[] = sn.map((n, idx) => ({
        id: n.id,
        type: 'storyNode',
        position: { x: 80 + (idx % 3) * 260, y: 80 + Math.floor(idx / 3) * 160 },
        data: {
          label: n.title,
          type: n.type,
          status: n.status,
          summary: n.summary,
        },
      }));

      const edgesRf: Edge[] = es.map((e) => ({
        id: e.id,
        source: e.src_node_id,
        target: e.dst_node_id,
        type: 'smoothstep',
        style: { stroke: '#ccc', strokeWidth: 2 },
        label: e.label,
      }));

      setNodes(nodesRf);
      setEdges(edgesRf);
    } catch (error) {
      console.error('Failed to load graph data:', error);
      setNodes([]);
      setEdges([]);
    }
  }, [setNodes, setEdges]);

  useEffect(() => {
    loadGraphData();
  }, [loadGraphData]);

  useEffect(() => {
    events.on('nodes:changed', loadGraphData);
    return () => events.off('nodes:changed', loadGraphData);
  }, [loadGraphData]);

  const onConnect = useCallback(
    async (params: Edge | Connection) => {
      try {
        const edgeId = `edge_${Date.now()}`;
        const pid = projectId || (await ensureProjectId());
        const newEdge: NodeEdge = {
          id: edgeId,
          project_id: pid,
          src_node_id: params.source!,
          dst_node_id: params.target!,
          kind: 'chronology',
          weight: 1.0,
          created_at: new Date().toISOString()
        };

        await run(`
          INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, weight, created_at)
          VALUES ('${newEdge.id}', '${newEdge.project_id}', '${newEdge.src_node_id}', '${newEdge.dst_node_id}', '${newEdge.kind}', ${newEdge.weight}, '${newEdge.created_at}')
        `);

        addStoreEdge(newEdge);
        events.emit('graph:edge-created', { edge: newEdge });
        loadGraphData();
      } catch (error) {
        console.error('Failed to create edge:', error);
      }
    },
    [addStoreEdge, loadGraphData, projectId]
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
    events.emit('graph:select', { nodeId: node.id });
  }, [setSelectedNodeId]);

  const createNode = useCallback(async (type: NodeType) => {
    try {
      const nodeId = `node_${Date.now()}`;
      const pid = projectId || (await ensureProjectId());
      const newNode: StoryNodeType = {
        id: nodeId,
        project_id: pid,
        type,
        title: `New ${type.charAt(0).toUpperCase() + type.slice(1)}`,
        order_key: Date.now(),
        status: 'draft',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await run(`
        INSERT INTO story_node (id, project_id, type, title, order_key, status, created_at, updated_at)
        VALUES ('${newNode.id}', '${newNode.project_id}', '${newNode.type}', '${newNode.title}', ${newNode.order_key}, '${newNode.status}', '${newNode.created_at}', '${newNode.updated_at}')
      `);

      addStoreNode(newNode);
      events.emit('graph:node-created', { node: newNode });
      events.emit('nodes:changed');
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [addStoreNode, projectId]);

  return (
    <>
      <div style={{ height: '100%', width: '100%', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 8 }}>
          <button
            onClick={() => createNode('chapter')}
            style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6, background: 'white', fontSize: 12 }}
          >
            + Chapter
          </button>
          <button
            onClick={() => createNode('scene')}
            style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6, background: 'white', fontSize: 12 }}
          >
            + Scene
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          fitView
          attributionPosition="bottom-left"
        >
          <Background />
          <Controls position="bottom-right" />
        </ReactFlow>
      </div>
    </>
  );
}

export function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphViewInner />
    </ReactFlowProvider>
  );
}
