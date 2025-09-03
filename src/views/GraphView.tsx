import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Plus } from 'lucide-react';
import { ChapterNode } from '../components/ChapterNode';
import { StoryStageGroup } from '../components/StoryStageGroup';
import { ChapterEditor } from '../components/ChapterEditor';
import { useEntitiesStore } from '../store/entities';

interface ChapterNodeData {
  chapterId: string;
  onEdit?: (chapterId: string) => void;
}

interface StoryStageGroupData {
  label: string;
  width: number;
  height: number;
  color?: string;
}

// Define nodeTypes outside component to prevent recreation on each render
const nodeTypes = {
  chapterNode: ChapterNode,
  storyStageGroup: StoryStageGroup,
};

function GraphViewInner() {
  const { 
    selectedNodeId,
    setSelectedNodeId,
    addNode: addStoreNode,
    addEdge: addStoreEdge
  } = useAppStore();
  
  const { chapters, storyStages, entities } = useEntitiesStore();
  const [nodes, setNodes, onNodesChange] = useNodesState<ChapterNodeData | StoryStageGroupData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [editingChapter, setEditingChapter] = useState<string | null>(null);
  const { } = useReactFlow();

  const loadGraphData = useCallback(async () => {
    try {
      console.log('Loading graph data from store...');
      
      const nodes: Node<ChapterNodeData | StoryStageGroupData>[] = [];
      const edges: Edge[] = [];

      // Group chapters by story stage
      const stageChapters = storyStages.map(stage => ({
        stage,
        chapters: chapters.filter(ch => ch.storyStage === stage.name)
      }));

      // Create story stage group nodes with auto-sizing
      stageChapters.forEach((stageData, stageIndex) => {
        const chaptersCount = stageData.chapters.length;
        const stageWidth = Math.max(300, chaptersCount * 280);
        const stageHeight = Math.max(180, Math.ceil(chaptersCount / 2) * 160 + 80);
        
        nodes.push({
          id: stageData.stage.id,
          type: 'storyStageGroup',
          position: { x: 50 + stageIndex * 450, y: 50 + (stageIndex % 2) * 300 },
          data: {
            label: stageData.stage.name,
            width: stageWidth,
            height: stageHeight,
            color: '#f8f8f8'
          },
          draggable: true,
          selectable: true
        });

        // Create chapter nodes positioned within their story stage
        stageData.chapters.forEach((chapter, chapterIndex) => {
          const chapterX = 30 + (chapterIndex % 2) * 250; // Relative to stage
          const chapterY = 50 + Math.floor(chapterIndex / 2) * 120; // Relative to stage
          
          nodes.push({
            id: chapter.id,
            type: 'chapterNode',
            position: { x: chapterX, y: chapterY },
            data: {
              chapterId: chapter.id,
              onEdit: setEditingChapter
            },
            parentNode: stageData.stage.id,
            extent: 'parent'
          });
        });
      });

      // Create edges between chapters
      for (let i = 0; i < chapters.length - 1; i++) {
        edges.push({
          id: `edge-${i}`,
          source: chapters[i].id,
          target: chapters[i + 1].id,
          type: 'smoothstep',
          style: { stroke: '#ccc', strokeWidth: 2 }
        });
      }

      setNodes(nodes);
      setEdges(edges);
    } catch (error) {
      console.error('Failed to load graph data:', error);
      setNodes([]);
      setEdges([]);
    }
  }, [chapters, storyStages, setNodes, setEdges, setEditingChapter]);

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
        const newEdge: NodeEdge = {
          id: edgeId,
          project_id: 'default', // TODO: get from project context
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
    [addStoreEdge, loadGraphData]
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
    events.emit('graph:select', { nodeId: node.id });
  }, [setSelectedNodeId]);

  const createNode = useCallback(async (type: NodeType) => {
    try {
      const nodeId = `node_${Date.now()}`;
      const newNode: StoryNodeType = {
        id: nodeId,
        project_id: 'default', // TODO: get from project context
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
  }, [addStoreNode]);

  return (
    <>
      <div style={{ height: '100%', width: '100%' }}>
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
      
      {editingChapter && (
        <ChapterEditor 
          chapterId={editingChapter} 
          onClose={() => setEditingChapter(null)} 
        />
      )}
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


