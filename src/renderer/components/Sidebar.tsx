import { ReactNode, useState, useEffect } from 'react';
import { useUiStore, SidebarType } from '../store/ui-store';
import { clampSidebarWidth } from '../lib/layout-geometry';

// Must match the `width` transition duration in index.css `.sidebar-shell`
// so children stay mounted through the outgoing slide, then unmount cleanly.
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
  const oppositeType: SidebarType = sidebarType === 'left' ? 'right' : 'left';
  const oppositeSidebarState = useUiStore((state) => state.sidebars[oppositeType]);
  // Fallback if state is missing (should not happen with correct store setup)
  const isExpanded = sidebarState?.isOpen ?? true;
  const persistedWidth = sidebarState?.width ?? 280;
  const oppositeOpenWidth = oppositeSidebarState?.isOpen ? oppositeSidebarState.width : 0;
  const expandedWidth = clampSidebarWidth(
    persistedWidth,
    sidebarType,
    typeof window === 'undefined' ? 1440 : window.innerWidth,
    oppositeOpenWidth,
  );

  // Resize Logic
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const setResizingSidebar = useUiStore((state) => state.setResizingSidebar);
  const [isResizing, setIsResizing] = useState(false);

  // Zustand restores sidebar widths from localStorage. Normalize that state
  // immediately and whenever the native window is resized so an old wide
  // layout cannot squeeze the editor out of view on a smaller display.
  useEffect(() => {
    const normalize = () => {
      const current = useUiStore.getState();
      const own = current.sidebars[sidebarType];
      const opposite = current.sidebars[oppositeType];
      const next = clampSidebarWidth(
        own.width,
        sidebarType,
        window.innerWidth,
        opposite.isOpen ? opposite.width : 0,
      );
      if (next !== own.width) setSidebarWidth(sidebarType, next);
    };
    normalize();
    window.addEventListener('resize', normalize);
    return () => window.removeEventListener('resize', normalize);
  }, [
    oppositeSidebarState?.isOpen,
    oppositeSidebarState?.width,
    oppositeType,
    persistedWidth,
    setSidebarWidth,
    sidebarType,
  ]);

  // Keep children mounted for the duration of the collapse animation so the
  // panel actually appears to slide out — without this they'd unmount the
  // moment `isExpanded` flips and the user would just see an empty bar shrink.
  // Re-expanding mid-collapse cancels the pending unmount via cleanup.
  const [mountChildren, setMountChildren] = useState(isExpanded);
  useEffect(() => {
    if (isExpanded) {
      // Exit-presence state is intentionally synchronized with the CSS
      // transition: reopening must cancel the delayed unmount immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMountChildren(true);
      return undefined;
    }
    const t = setTimeout(() => setMountChildren(false), COLLAPSE_ANIM_MS);
    return () => clearTimeout(t);
  }, [isExpanded]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const requestedWidth = sidebarType === 'left' ? e.clientX : window.innerWidth - e.clientX;
      const current = useUiStore.getState();
      const opposite = current.sidebars[oppositeType];
      const newWidth = clampSidebarWidth(
        requestedWidth,
        sidebarType,
        window.innerWidth,
        opposite.isOpen ? opposite.width : 0,
      );

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
  }, [isResizing, oppositeType, setSidebarWidth, setResizingSidebar, sidebarType]);

  // Two-layer geometry so open/close reads as a real slide:
  //   - outer (`.sidebar-shell`) is the layout-sized box; its `width`
  //     transitions between 0 and `expandedWidth`.
  //   - inner (`.sidebar-shell__content`) is absolutely positioned at the
  //     last known `expandedWidth` and anchored to the OUTSIDE edge (left
  //     sidebar → right:0; right sidebar → left:0). As the outer shrinks
  //     from the inside edge inward, the inner stays put and gets clipped
  //     from the inside, which reads as content sliding off-screen.
  const innerAnchorSide = sidebarType === 'left' ? 'right' : 'left';
  const showCollapsedSlot = !isExpanded && !mountChildren && Boolean(collapsedContent);
  const outerWidth = isExpanded
    ? expandedWidth
    : collapsedContent && showCollapsedSlot
      ? undefined
      : 0;

  // When collapsed without any collapsed-content slot the sidebar contributes
  // 0 visible width. Mark that state so the shell can zero out the
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
        // Also load-bearing for the slide animation: the inner
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
            // shell gutter still provides usable cursor area.
            right: sidebarType === 'left' ? 0 : 'auto',
            left: sidebarType === 'right' ? 0 : 'auto',
            // Hit zone (transparent until hovered). Widened to 16 for an easier
            // grab — it extends inward from the inside edge (root is
            // overflow:hidden, so it can't straddle outward; the 6px shell
            // gutter adds reachable area on the outside).
            width: 16,
            height: '100%',
            cursor: 'col-resize',
            zIndex: 10,
          }}
        />
      )}
    </div>
  );
}
