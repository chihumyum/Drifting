import { Settings } from 'lucide-react';
import { events } from '../lib/events';

export function SidebarTopBar() {
  const isMac = navigator.userAgent.includes('Mac');
  
  if (!isMac) {
    return null;
  }

  const handleOpenSettings = () => {
    events.emit('settings:open');
  };

  return (
    <div
      style={{
        height: 52,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 100, // 为红绿灯留空间
        paddingRight: 16,
        flexShrink: 0,
        borderBottom: '1px solid rgba(213, 213, 213, 0.15)',
        WebkitAppRegion: 'drag', // 允许拖拽窗口
      } as React.CSSProperties}
    >
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
        <Settings size={16} />
      </button>
    </div>
  );
}