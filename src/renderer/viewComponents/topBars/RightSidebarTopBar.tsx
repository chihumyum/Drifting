import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';
import { RightSidebarHeader } from '../rightBars/RightSidebarHeader';

export function RightSidebarTopBar() {
  const isMac = navigator.userAgent.includes('Mac');
  const isRightSidebarOpen = useUiStore((state) => state.sidebars.right.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  if (!isMac) {
    return null;
  }

  const iconSize = 20;

  return (
    <div
      style={
        {
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: isRightSidebarOpen ? 'flex-start' : 'flex-end',
          paddingLeft: isRightSidebarOpen ? 6 : 8,
          paddingRight: 8,
          gap: isRightSidebarOpen ? 6 : 0,
          borderBottom: '1px solid rgba(213, 213, 213, 0.15)',
          width: '100%',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
    >
      <button
        onClick={() => toggleSidebar('right')}
        style={
          {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: '#5a5a5a',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties
        }
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(139, 127, 168, 0.1)';
          e.currentTarget.style.color = '#3a3a3a';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#5a5a5a';
        }}
        title="Toggle Right Sidebar"
      >
        {isRightSidebarOpen ? (
          <PanelRightClose size={iconSize} />
        ) : (
          <PanelRightOpen size={iconSize} />
        )}
      </button>
      {isRightSidebarOpen && (
        <div
          style={
            {
              flex: 1,
              minWidth: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        >
          <RightSidebarHeader inline />
        </div>
      )}
    </div>
  );
}
