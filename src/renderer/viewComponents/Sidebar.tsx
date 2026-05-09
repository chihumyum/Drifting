import { ReactNode, useState, useEffect } from 'react';
import { useUiStore, SidebarType } from '../store/ui-store';

interface SidebarProps {
  sidebarType: SidebarType; // 指定侧边栏类型
  topBar?: ReactNode; // 顶部固定区域（如 LeftSidebarTopBar）
  children?: ReactNode; // 可插拔的内容区域（如 QuickButtons + ElementPanel）
  collapsedContent?: ReactNode; // 收起状态下显示的内容
  defaultExpanded?: boolean; // deprecated, managed by store
  defaultWidth?: number; // deprecated, managed by store
}

export function Sidebar({ sidebarType, topBar, children, collapsedContent }: SidebarProps) {
  const sidebarState = useUiStore((state) => state.sidebars[sidebarType]);
  // Fallback if state is missing (should not happen with correct store setup)
  const isExpanded = sidebarState?.isOpen ?? true;
  const expandedWidth = sidebarState?.width ?? 280;

  // Resize Logic
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const setResizingSidebar = useUiStore((state) => state.setResizingSidebar);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      let newWidth = sidebarType === 'left' ? e.clientX : window.innerWidth - e.clientX;
      const minWidth = 220;
      const maxWidth = window.innerWidth * 0.3;

      if (newWidth < minWidth) newWidth = minWidth;
      if (newWidth > maxWidth) newWidth = maxWidth;

      setSidebarWidth(sidebarType, newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizingSidebar(null);
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizing, setSidebarWidth, setResizingSidebar, sidebarType]);

  return (
    <div
      style={{
        width: isExpanded ? expandedWidth : collapsedContent ? undefined : 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#fefdfb',
        borderRight: sidebarType === 'left' ? '1px solid rgba(213, 213, 213, 0.3)' : 'none',
        borderLeft: sidebarType === 'right' ? '1px solid rgba(213, 213, 213, 0.3)' : 'none',
        position: 'relative',
        overflow: 'visible',
      }}
    >
      {/* 顶部固定区域 */}
      {topBar && <div style={{ flexShrink: 0 }}>{topBar}</div>}

      {/* 可插拔的内容区域 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: 'column',
          overflow: 'visible',
          position: 'relative',
          display: 'flex',
        }}
      >
        {/* 内容区域 - 根据展开状态显示 */}
        {isExpanded ? children : collapsedContent}
      </div>

      {isExpanded && (
        <div
          onMouseDown={() => {
            setIsResizing(true);
            setResizingSidebar(sidebarType);
          }}
          style={{
            position: 'absolute',
            top: 0,
            right: sidebarType === 'left' ? -3 : 'auto',
            left: sidebarType === 'right' ? -3 : 'auto',
            width: 6,
            height: '100%',
            cursor: 'col-resize',
            zIndex: 10,
            // background: 'rgba(0,0,0,0.1)', // debug
          }}
        />
      )}
    </div>
  );
}
