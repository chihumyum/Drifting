import { Settings } from 'lucide-react';
import { events } from '../lib/events';

interface TopBarProps {
  centerContent?: React.ReactNode;
  rightContent?: React.ReactNode;
}

export function TopBar({ centerContent, rightContent }: TopBarProps) {
  const isMac = navigator.userAgent.includes('Mac');
  const topBarHeight = isMac ? 40 : 0;

  if (!isMac) {
    return null;
  }

  const handleOpenSettings = () => {
    events.emit('settings:open');
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: topBarHeight,
        display: 'flex',
        zIndex: 1000,
        background: 'transparent',
      }}
    >
      {/* 左段：侧栏区域（280px） */}
      <div
        style={{
          width: 280,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 80, // 为红绿灯留空间
          paddingRight: 16,
          flexShrink: 0,
          borderRight: '1px solid rgba(213, 213, 213, 0.3)',
          pointerEvents: 'auto',
        }}
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
          }}
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

      {/* 中段：内容区域（可拖拽） */}
      <div
        style={{
          flex: 1,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingLeft: 16,
          paddingRight: 16,
          WebkitAppRegion: 'drag',
          pointerEvents: 'auto',
        } as React.CSSProperties}
      >
        <div style={{ pointerEvents: 'none' }}>
          {centerContent}
        </div>
      </div>

      {/* 右段：编辑器操作区域 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingRight: 16,
          height: '100%',
          WebkitAppRegion: 'no-drag',
          pointerEvents: 'auto',
        } as React.CSSProperties}
      >
        {rightContent}
      </div>
    </div>
  );
}
