import { Settings, User, HelpCircle, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { useAppStore } from '../store';

export function AppSidebar() {
  const navigate = useNavigate();
  const { createNode } = useBookNodeUsecases();
  const bookNodes = useAppStore(state => state.bookNodes);
  
  const leftMenuItems = [
    { icon: User, label: 'Account' },
    { icon: Settings, label: 'Settings' },
    { icon: HelpCircle, label: 'Help' },
  ];

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
      {/* Left Column - App Settings */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 8px',
        background: 'transparent',
      }}>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {leftMenuItems.map((item, index) => (
            <button
              key={index}
              onClick={() => alert(`${item.label} clicked`)}
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
              title={item.label}
            >
              <item.icon size={18} />
            </button>
          ))}
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
          className="bg-button"
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
      </div>
    </div>
  );
}
