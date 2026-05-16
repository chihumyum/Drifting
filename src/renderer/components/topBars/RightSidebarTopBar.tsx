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

  const iconSize = 16;

  return (
    <div
      style={
        {
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: isRightSidebarOpen ? 'flex-start' : 'flex-end',
          paddingLeft: isRightSidebarOpen ? 8 : 8,
          paddingRight: 8,
          gap: isRightSidebarOpen ? 8 : 0,
          borderBottom: '1px solid hsl(var(--rule))',
          width: '100%',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
    >
      <button
        onClick={() => toggleSidebar('right')}
        title={isRightSidebarOpen ? 'Close Right Sidebar' : 'Open Right Sidebar'}
        style={
          {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 4,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-3))',
            cursor: 'pointer',
            transition: 'background 0.15s ease, color 0.15s ease',
            WebkitAppRegion: 'no-drag',
            padding: 0,
            flexShrink: 0,
          } as React.CSSProperties
        }
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          e.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'hsl(var(--ink-3))';
        }}
      >
        {isRightSidebarOpen ? (
          <PanelRightClose size={iconSize} strokeWidth={1.6} />
        ) : (
          <PanelRightOpen size={iconSize} strokeWidth={1.6} />
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
