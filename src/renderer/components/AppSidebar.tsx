import { Settings, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { useStorylineUsecases } from '../hooks/useStorylineUsecases';
import { useAppStore } from '../store';
import { useAuthStore, getProjectId } from '../store/auth';
import { events } from '../lib/events';

// Storyline color palette
const STORYLINE_COLORS = [
  '#b89968', // gold
  '#6b9080', // sage
  '#a3b18a', // moss
  '#bc6c25', // rust
  '#588157', // forest
  '#8b7355', // brown
  '#7a9e9f', // teal
  '#946b54', // terracotta
];

export function AppSidebar() {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const { createNode, loadNodes } = useBookNodeUsecases();
  const storylineUsecases = useStorylineUsecases();
  const bookNodes = useAppStore(state => state.bookNodes);
  const selectedNodeId = useAppStore(state => state.selectedNodeId);

  const handleCreateChapter = async () => {
    try {
      // Find the maximum end position among all nodes
      // If no nodes exist, start from position 1
      const maxEnd = bookNodes.length > 0 
        ? bookNodes.reduce((max, node) => {
            const nodeEnd = node.end ?? node.start;
            return Math.max(max, nodeEnd);
          }, 0)
        : 0; // Start from 0 so first node begins at 1
      const newStart = maxEnd + 1;
      const newEnd = newStart + 10; // Default chapter length
      
      const newNode = await createNode({
        title: 'New Chapter',
        start: newStart,
        end: newEnd,
      });
      
      // 分配默认 storyline
      let defaultStorylineId: string | null = null;
      
      if (selectedNodeId) {
        // 如果有选中的 node，获取它的主 storyline（第一个 storyline）
        const selectedNodeStorylines = await storylineUsecases.getStorylinesByNode(selectedNodeId);
        if (selectedNodeStorylines.length > 0) {
          defaultStorylineId = selectedNodeStorylines[0].id;
        }
      }
      
      if (!defaultStorylineId) {
        // 如果没有选中 node 或选中的 node 没有 storyline，随便选一个 storyline
        const projectId = getProjectId(user?.id);
        const allStorylines = await storylineUsecases.getStorylinesByProject(projectId);
        if (allStorylines.length > 0) {
          defaultStorylineId = allStorylines[0].id;
        }
      }
      
      // 将新 node 添加到 storyline
      if (defaultStorylineId) {
        await storylineUsecases.addNodeToStoryline(newNode.id, defaultStorylineId);
      }
      
      // Reload nodes to ensure timeline picks up the new node with its storyline relationship
      await loadNodes();
      
      // 设置为选中状态
      useAppStore.getState().setSelectedNodeId(newNode.id);
      
      // Navigate to the new chapter
      navigate(`/editor/${newNode.id}`);
      
      // Scroll timeline to the new chapter position
      setTimeout(() => {
        const timelineContainer = document.querySelector('[data-timeline-container]') as HTMLElement;
        if (timelineContainer) {
          const GRID_UNIT = 20; // Same as TIMELINE_CONFIG.GRID_UNIT
          const scrollPosition = newStart * GRID_UNIT;
          timelineContainer.scrollTo({
            left: scrollPosition,
            behavior: 'smooth',
          });
        }
      }, 100);
    } catch (error) {
      console.error('Failed to create chapter:', error);
    }
  };

  const handleCreateStoryline = async () => {
    try {
      const projectId = getProjectId(user?.id);
      
      // Generate random color
      const randomColor = STORYLINE_COLORS[Math.floor(Math.random() * STORYLINE_COLORS.length)];
      
      // Create new storyline
      const newStoryline = await storylineUsecases.createStoryline({
        projectId,
        name: 'New Storyline',
        color: randomColor,
        summary: '',
      });
      
      // Navigate to storyline editor
      navigate(`/editor/storyline/${newStoryline.id}`);
    } catch (error) {
      console.error('Failed to create storyline:', error);
    }
  };

  const handleOpenSettings = () => {
    events.emit('settings:open');
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1px',
        background: 'rgba(213, 213, 213, 0.2)',
        padding: '8px',
      }}
    >
        <button
          onClick={handleCreateChapter}
          className="bg-accent hover:bg-accent-hover text-paper transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '12px',
            borderRadius: '8px',
            border: 'none',
            color: 'rgba(0, 0, 0, 0.75)',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
          }}
        >
          <Plus size={16} />
          <span>Chapter</span>
        </button>
        
        <button
          onClick={handleCreateStoryline}
          className="bg-accent hover:bg-accent-hover text-paper transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '12px',
            borderRadius: '8px',
            border: 'none',
            color: 'rgba(0, 0, 0, 0.75)',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
          }}
        >
          <Plus size={16} />
          <span>Storyline</span>
        </button>
      </div>
  );
}

