import { Plus } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useDataStore } from '../../store/data-store';
import { useAuthStore, getProjectId } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

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

export function LeftQuickButtons() {
  const location = useLocation();
  const { nodeId } = useParams<{ nodeId?: string }>();
  const user = useAuthStore(state => state.user);
  const { createNode, loadNodes } = useBookNode();
  const { createStoryline, getStorylinesByNode, addNodeToStoryline, loadStorylines } = useStoryline();
  const bookNodes = useDataStore(state => state.bookNodes);
  const { navigateToNode, navigateToStoryline } = useProjectNavigation();

  // Check if we're currently in a storyline editor
  const getCurrentStorylineId = (): string | null => {
    const match = location.pathname.match(/^\/editor\/storyline\/([^/]+)$/);
    return match ? match[1] : null;
  };

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
      
      // 确定要添加到哪个 storyline
      let defaultStorylineId: string | null = null;
      
      // 优先级1: 如果当前在 storyline editor 中，使用当前 storyline
      const currentStorylineId = getCurrentStorylineId();
      if (currentStorylineId) {
        defaultStorylineId = currentStorylineId;
      }
      // 优先级2: 如果有选中的 node，获取它的主 storyline（第一个 storyline）
      else if (selectedNodeId) {
        const selectedNodeStorylines = await storylineUsecases.getStorylinesByNode(selectedNodeId);
        if (selectedNodeStorylines.length > 0) {
          defaultStorylineId = selectedNodeStorylines[0].id;
        }
      }
      
      // 优先级3: 如果没有选中 node 或选中的 node 没有 storyline，随便选一个 storyline
      if (!defaultStorylineId) {
        const projectId = getProjectId(user?.id);
        const allStorylines = await storylineUsecases.getStorylinesByProject(projectId);
        if (allStorylines.length > 0) {
          defaultStorylineId = allStorylines[0].id;
        }
      }
      
      // 将新 node 添加到 storyline
      if (defaultStorylineId) {
        await addNodeToStoryline(newNode.id, defaultStorylineId);
      }
      
      // Reload nodes to ensure timeline picks up the new node with its storyline relationship
      await loadNodes();
      
      // Navigate to the new chapter
      navigateToNode(newNode.id);
      
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
      log.error('Failed to create chapter:', error);
    }
  };

  const handleCreateStoryline = async () => {
    try {
      const projectId = getProjectId(user?.id);
      
      // Generate random color
      const randomColor = STORYLINE_COLORS[Math.floor(Math.random() * STORYLINE_COLORS.length)];
      
      // Create new storyline
      const newStoryline = await createStoryline({
        projectId,
        name: 'New Storyline',
        color: randomColor,
        summary: '',
      });
      
      // Reload all storylines to update the store and trigger timeline refresh
      await loadStorylines(projectId);
      
      // Navigate to storyline editor
      navigateToStoryline(newStoryline.id);
    } catch (error) {
      log.error('Failed to create storyline:', error);
    }
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

