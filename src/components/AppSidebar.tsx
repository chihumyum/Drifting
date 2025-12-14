import { Settings, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { useStoryThreadUsecases } from '../hooks/useStoryThreadUsecases';
import { useAppStore } from '../store';
import { useAuthStore, getProjectId } from '../store/auth';
import { events } from '../lib/events';

// Thread color palette
const THREAD_COLORS = [
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
  const { createNode } = useBookNodeUsecases();
  const threadUsecases = useStoryThreadUsecases();
  const bookNodes = useAppStore(state => state.bookNodes);
  const selectedNodeId = useAppStore(state => state.selectedNodeId);

  const handleCreateChapter = async () => {
    try {
      // Find the maximum end position among all nodes
      const maxEnd = bookNodes.reduce((max, node) => {
        const nodeEnd = node.end ?? node.start;
        return Math.max(max, nodeEnd);
      }, 0);
      const newStart = maxEnd + 1;
      const newEnd = newStart + 10; // Default chapter length
      
      const newNode = await createNode({
        title: 'New Chapter',
        start: newStart,
        end: newEnd,
      });
      
      // 分配默认 thread
      let defaultThreadId: string | null = null;
      
      if (selectedNodeId) {
        // 如果有选中的 node，获取它的主 thread（第一个 thread）
        const selectedNodeThreads = await threadUsecases.getThreadsByNode(selectedNodeId);
        if (selectedNodeThreads.length > 0) {
          defaultThreadId = selectedNodeThreads[0].id;
        }
      }
      
      if (!defaultThreadId) {
        // 如果没有选中 node 或选中的 node 没有 thread，随便选一个 thread
        const projectId = getProjectId(user?.id);
        const allThreads = await threadUsecases.getThreadsByProject(projectId);
        if (allThreads.length > 0) {
          defaultThreadId = allThreads[0].id;
        }
      }
      
      // 将新 node 添加到 thread
      if (defaultThreadId) {
        await threadUsecases.addNodeToThread(newNode.id, defaultThreadId);
      }
      
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

  const handleCreateThread = async () => {
    try {
      const projectId = getProjectId(user?.id);
      
      // Generate random color
      const randomColor = THREAD_COLORS[Math.floor(Math.random() * THREAD_COLORS.length)];
      
      // Create new thread
      const newThread = await threadUsecases.createThread({
        projectId,
        name: 'New Thread',
        color: randomColor,
        summary: '',
      });
      
      // Navigate to thread editor
      navigate(`/editor/thread/${newThread.id}`);
    } catch (error) {
      console.error('Failed to create thread:', error);
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
      }}
    >
      {/* Left Column - Settings Button */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 8px',
        background: 'transparent',
      }}>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <button
            onClick={() => events.emit('settings:open')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '10px',
              borderRadius: '8px',
              border: 'none',
              background: 'transparent',
              color: '#000000b1',
              fontSize: '13px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(234, 168, 102, 0.15)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
            }}
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </nav>
      </div>

      {/* Right Column - Action Buttons */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 8px',
        gap: '8px',
        background: 'transparent',
      }}>
        <button
          onClick={handleCreateChapter}
          className="bg-accent hover:bg-accent-hover text-paper transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '10px 12px',
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
          onClick={handleCreateThread}
          className="bg-accent hover:bg-accent-hover text-paper transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '10px 12px',
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
          <span>Thread</span>
        </button>
      </div>
    </div>
  );
}
