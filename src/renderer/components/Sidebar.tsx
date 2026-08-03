import { ReactNode, useState, useEffect } from 'react';
import { useUiStore, SidebarType } from '../store/ui-store';
import { clampSidebarWidth } from '../lib/layout-geometry';

// Must match the `width` transition duration in index.css `.sidebar-shell`
// so children stay mounted through the outgoing slide, then unmount cleanly.
const COLLAPSE_ANIM_MS = 220;

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

    const root = document.documentElement;
    const body = document.body;
    const previousRootUserSelect = root.style.userSelect;
    const previousRootWebkitUserSelect = root.style.getPropertyValue('-webkit-user-select');
    const previousBodyUserSelect = body.style.userSelect;
    const previousBodyWebkitUserSelect = body.style.getPropertyValue('-webkit-user-select');
    const previousBodyCursor = body.style.cursor;

    const preventSelection = (event: Event) => event.preventDefault();

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
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

    const stopResizing = () => {
      setIsResizing(false);
      setResizingSidebar(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);
    document.addEventListener('selectstart', preventSelection, true);
    window.addEventListener('blur', stopResizing);

    // `preventDefault` on the resize handle stops the initial selection.
    // These document-level guards also cover text/contenteditable nodes that
    // the pointer crosses later in the drag, including WebKit's native
    // selectstart path.
    root.style.userSelect = 'none';
    root.style.setProperty('-webkit-user-select', 'none');
    body.style.userSelect = 'none';
    body.style.setProperty('-webkit-user-select', 'none');
    body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', stopResizing);
      document.removeEventListener('selectstart', preventSelection, true);
      window.removeEventListener('blur', stopResizing);
      root.style.userSelect = previousRootUserSelect;
      body.style.userSelect = previousBodyUserSelect;
      body.style.cursor = previousBodyCursor;
      if (previousRootWebkitUserSelect) {
        root.style.setProperty('-webkit-user-select', previousRootWebkitUserSelect);
      } else {
        root.style.removeProperty('-webkit-user-select');
      }
      if (previousBodyWebkitUserSelect) {
        body.style.setProperty('-webkit-user-select', previousBodyWebkitUserSelect);
      } else {
        body.style.removeProperty('-webkit-user-select');
      }
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
  // inside-facing seam (see `.sidebar-shell.is-fully-hidden` in index.css),
  // letting the editor column reclaim the complete workspace width.
  const isFullyHidden = !isExpanded && !collapsedContent;

  return (
    <div
      className={`app-panel-plane sidebar-shell sidebar-shell--${sidebarType} ${
        isExpanded ? 'is-expanded' : 'is-collapsed'
      }${isFullyHidden ? ' is-fully-hidden' : ''}`}
      style={{
        width: outerWidth,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        // Load-bearing for the slide animation: the fixed-width inner slab is
        // clipped here as the outer column shrinks.
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
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            setIsResizing(true);
            setResizingSidebar(sidebarType);
          }}
          style={{
            position: 'absolute',
            top: 0,
            // Sit flush against the inside edge of the anchored slab.
            right: sidebarType === 'left' ? 0 : 'auto',
            left: sidebarType === 'right' ? 0 : 'auto',
            // Hit zone (transparent until hovered). Widened to 16 for an easier
            // grab — it extends inward because the sliding slab clips overflow.
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
