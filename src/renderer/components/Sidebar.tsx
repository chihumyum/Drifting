import { ReactNode, useState, useEffect } from 'react';
import { useUiStore, SidebarType } from '../store/ui-store';

// Modern's open/close slide. Must match the `width` transition duration in
// index.css `.sidebar-shell` so children stay mounted long enough for the
// outgoing slide to play out, then unmount cleanly.
const COLLAPSE_ANIM_MS = 280;

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

  // Keep children mounted for the duration of the collapse animation so the
  // panel actually appears to slide out — without this they'd unmount the
  // moment `isExpanded` flips and modern would just see an empty bar shrink.
  // Re-expanding mid-collapse cancels the pending unmount via cleanup.
  const [mountChildren, setMountChildren] = useState(isExpanded);
  useEffect(() => {
    if (isExpanded) {
      setMountChildren(true);
      return undefined;
    }
    const t = setTimeout(() => setMountChildren(false), COLLAPSE_ANIM_MS);
    return () => clearTimeout(t);
  }, [isExpanded]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      let newWidth = sidebarType === 'left' ? e.clientX : window.innerWidth - e.clientX;
      // 对齐 collapsed 状态下 LeftSidebarTopBar 分隔线位置（AppTopbar 中 LEFT_COLLAPSED_WIDTH = 140）。
      const minWidth = 140;
      // Right sidebar gets a wider cap so it can reach the ~850px split
      // threshold (two columns) on roomy screens; left stays at 30%.
      const maxWidth = window.innerWidth * (sidebarType === 'right' ? 0.6 : 0.3);

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

  // Two-layer geometry so modern's open/close slide reads as a real slide:
  //   - outer (`.sidebar-shell`) is the layout-sized box; its `width`
  //     transitions between 0 and `expandedWidth`.
  //   - inner (`.sidebar-shell__content`) is absolutely positioned at the
  //     last known `expandedWidth` and anchored to the OUTSIDE edge (left
  //     sidebar → right:0; right sidebar → left:0). As the outer shrinks
  //     from the inside edge inward, the inner stays put and gets clipped
  //     from the inside, which reads as content sliding off-screen.
  // Classic skips the transition entirely (see index.css) so the layout
  // snap behavior is unchanged.
  const innerAnchorSide = sidebarType === 'left' ? 'right' : 'left';
  const showCollapsedSlot = !isExpanded && !mountChildren && Boolean(collapsedContent);
  const outerWidth = isExpanded
    ? expandedWidth
    : collapsedContent && showCollapsedSlot
      ? undefined
      : 0;

  // When collapsed without any collapsed-content slot the sidebar contributes
  // 0 visible width. Mark that state so the modern skin can zero out the
  // inside-facing margin (see `.sidebar-shell.is-fully-hidden` in index.css),
  // letting the editor + bottom-timeline column align flush with the topbar
  // and BSB right edges.
  const isFullyHidden = !isExpanded && !collapsedContent;

  return (
    <div
      className={`app-chrome app-island sidebar-shell sidebar-shell--${sidebarType} ${
        isExpanded ? 'is-expanded' : 'is-collapsed'
      }${isFullyHidden ? ' is-fully-hidden' : ''}`}
      style={{
        width: outerWidth,
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
        // Also load-bearing for the modern slide animation: the inner
        // fixed-width content is clipped here as the outer shrinks.
        overflow: 'hidden',
        // Suppress the width transition during a drag-resize, otherwise the
        // outer lags behind the cursor and the resize feels rubbery.
        transition: isResizing ? 'none' : undefined,
      }}
    >
      {showCollapsedSlot ? (
        <>
          {/* Collapsed-state inline slot — only used when caller passes
              `collapsedContent` and the slide-out has finished. */}
          {topBar && <div style={{ flexShrink: 0 }}>{topBar}</div>}
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
            {collapsedContent}
          </div>
        </>
      ) : (
        <div
          className="sidebar-shell__content"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [innerAnchorSide]: 0,
            width: expandedWidth,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {topBar && <div style={{ flexShrink: 0 }}>{topBar}</div>}
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
            {mountChildren ? children : null}
          </div>
        </div>
      )}

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
            // Hit zone (transparent). Widened from 6→12 for an easier grab; it
            // extends inward from the inside edge (root is overflow:hidden, so
            // it can't straddle outward — the modern skin's 6px gutter adds a
            // little more reachable area on the outside).
            width: 12,
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
