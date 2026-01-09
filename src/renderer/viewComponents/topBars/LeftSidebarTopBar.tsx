import { Settings, Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { events } from '../../lib/events.ts';
import { useUiStore } from '../../store/ui-store';

export function LeftSidebarTopBar() {
  const isMac = navigator.userAgent.includes('Mac');
  const isLeftSidebarOpen = useUiStore((state) => state.sidebars.left.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  if (!isMac) {
    return null;
  }

  const handleOpenSettings = () => {
    events.emit('settings:open');
  };

  const handleOpenSearch = () => {
    events.emit('search:open');
  };

  const handleToggleLeftSidebar = () => {
    toggleSidebar('left');
  };


  const iconSize = 20;


  return (
    <div
      style={{
        height: 42,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 90, // 为红绿灯留空间
        paddingRight: 16,
        flexShrink: 0,
        borderBottom: '1px solid rgba(213, 213, 213, 0.15)',
        WebkitAppRegion: 'drag', // 允许拖拽窗口
        // border: '2px solid rgba(0, 0, 0, 1)', 
        width: '100%',
      } as React.CSSProperties}
    >
      {isLeftSidebarOpen && (
        <>
        <button
          onClick={handleOpenSettings}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: '6px',
            border: 'none',
            background: 'transparent',
            color: '#5a5a5a',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            WebkitAppRegion: 'no-drag', // 按钮区域不可拖拽
          } as React.CSSProperties}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(139, 127, 168, 0.1)';
            e.currentTarget.style.color = '#3a3a3a';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#5a5a5a';
          }}
          title="Settings"
        >
          <Settings size={iconSize} />
        </button>
        <button
          onClick={handleOpenSearch}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: '6px',
            border: 'none',
            background: 'transparent',
            color: '#5a5a5a',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            WebkitAppRegion: 'no-drag',
            marginRight: 'auto',
          } as React.CSSProperties}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(139, 127, 168, 0.1)';
            e.currentTarget.style.color = '#3a3a3a';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#5a5a5a';
          }}
          title="Search"
        >
          <Search size={iconSize} />
        </button>
        </>
      )}
      {/* white space */}
      <button
        onClick={handleToggleLeftSidebar}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: '6px',
          border: 'none',
          background: 'transparent',
          color: '#5a5a5a',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          WebkitAppRegion: 'no-drag',
          marginLeft: 'auto',
        } as React.CSSProperties}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(139, 127, 168, 0.1)';
          e.currentTarget.style.color = '#3a3a3a';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#5a5a5a';
        }}
        title="Toggle Left Sidebar"
      >
        {isLeftSidebarOpen ? 
        <PanelLeftClose size={iconSize} /> :
        <PanelLeftOpen size={iconSize} />}
      </button>
    </div>
  );
}