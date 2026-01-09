import { ReactNode } from 'react';
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

  return (
    <div
      style={{
        width: isExpanded ? expandedWidth : (collapsedContent ? undefined : 0),
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
          flexDirection: 'column',
          overflow: 'visible',
          position: 'relative',
          display: isExpanded ? 'flex' : 'none',
        }}
      >
        {/* 内容区域 - 根据展开状态显示 */}
        {isExpanded && children}

        {/* 收起状态的提示 */}
        {!isExpanded && collapsedContent}
      </div>
    </div>
  );
}
