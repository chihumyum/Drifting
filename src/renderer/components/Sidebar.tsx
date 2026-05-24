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
      // 对齐 collapsed 状态下 LeftSidebarTopBar 分隔线位置（AppTopbar 中 LEFT_COLLAPSED_WIDTH = 140）。
      const minWidth = 140;
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
      className="app-chrome app-island"
      style={{
        width: isExpanded ? expandedWidth : collapsedContent ? undefined : 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--chrome-bg)',
        borderRight: sidebarType === 'left' ? 'var(--chrome-divider)' : 'none',
        borderLeft: sidebarType === 'right' ? 'var(--chrome-divider)' : 'none',
        position: 'relative',
        // `hidden` (not `visible`) so border-radius actually clips child bg
        // — without this the right sidebar's panel header / left sidebar's
        // tab tray paint their full-width bg over the rounded top corners
        // and the island shape doesn't show. Cost: resize handle has to
        // live inside the bounds instead of straddling them (see below).
        overflow: 'hidden',
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
            // Sit flush against the inside edge (not straddling -3..+3 like
            // before). Required because the root now has `overflow: hidden`
            // for border-radius clipping, which would otherwise crop the
            // straddling handle to a 3px sliver. The 6px gap around each
            // sidebar in modern still provides plenty of cursor area, and
            // classic loses nothing visible (handle was transparent).
            right: sidebarType === 'left' ? 0 : 'auto',
            left: sidebarType === 'right' ? 0 : 'auto',
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
