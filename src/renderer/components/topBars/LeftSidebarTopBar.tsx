import { Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { events } from '../../lib/events.ts';
import { useUiStore } from '../../store/ui-store';

export function LeftSidebarTopBar() {
  const isMac = navigator.userAgent.includes('Mac');
  const isLeftSidebarOpen = useUiStore((state) => state.sidebars.left.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  if (!isMac) {
    return null;
  }

  const handleOpenSearch = () => events.emit('search:open');
  const handleToggleLeftSidebar = () => toggleSidebar('left');

  const iconSize = 16;

  return (
    <div
      style={
        {
          height: 42,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 78, // 红绿灯 (traffic lights) 让位
          paddingRight: 8,
          flexShrink: 0,
          borderBottom: '1px solid hsl(var(--rule))',
          WebkitAppRegion: 'drag',
          width: '100%',
          gap: 2,
        } as React.CSSProperties
      }
    >
      <GhostIconBtn onClick={handleOpenSearch} title="Search" icon={<Search size={iconSize} strokeWidth={1.6} />} />
      <GhostIconBtn
        onClick={handleToggleLeftSidebar}
        title={isLeftSidebarOpen ? 'Close Left Sidebar' : 'Open Left Sidebar'}
        marginLeftAuto={isLeftSidebarOpen}
        marginLeft={isLeftSidebarOpen ? 'auto' : 6}
        icon={
          isLeftSidebarOpen ? (
            <PanelLeftClose size={iconSize} strokeWidth={1.6} />
          ) : (
            <PanelLeftOpen size={iconSize} strokeWidth={1.6} />
          )
        }
      />
    </div>
  );
}

interface GhostIconBtnProps {
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
  marginLeftAuto?: boolean;
  marginLeft?: number | 'auto';
}

function GhostIconBtn({ onClick, title, icon, marginLeft }: GhostIconBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
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
          marginLeft,
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
      {icon}
    </button>
  );
}
