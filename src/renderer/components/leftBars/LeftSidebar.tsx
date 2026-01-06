import { useState, useEffect, ReactNode } from 'react';
import { events } from '../../lib/events';

interface LeftSidebarProps {
  topBar?: ReactNode; // 顶部固定区域（如 LeftSidebarTopBar）
  children?: ReactNode; // 可插拔的内容区域（如 QuickButtons + ElementPanel）
  collapsible?: boolean; // 是否可以收起可插拔部分
}

export function LeftSidebar({ topBar, children, collapsible = true }: LeftSidebarProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // 监听全局事件
  useEffect(() => {
    const handleToggle = () => {
      setIsExpanded(prev => !prev);
    };

    events.on('left-sidebar:toggle', handleToggle);
    return () => events.off('left-sidebar:toggle', handleToggle);
  }, []);

  return (
    <div
      style={{
        width: 280,
        display: 'flex',
        flexDirection: 'column',
        background: '#fefdfb',
        borderRight: '1px solid rgba(213, 213, 213, 0.3)',
        position: 'relative',
        overflow: 'visible',
      }}
    >
      {/* 顶部固定区域 */}
      {topBar && (
        <div style={{ flexShrink: 0 }}>
          {topBar}
        </div>
      )}

      {/* 可插拔的内容区域 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          position: 'relative',
        }}
      >
        {/* 内容区域 - 根据展开状态显示 */}
        {isExpanded && children}

        {/* 收起状态的提示 */}
        {!isExpanded && collapsible && children && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'rgba(90, 74, 58, 0.5)',
              fontSize: 13,
              fontStyle: 'italic',
            }}
          >
            侧边栏已收起
          </div>
        )}
      </div>
    </div>
  );
}
