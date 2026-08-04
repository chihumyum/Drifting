import { LeftSidebarTopBar } from '../components/topBars/LeftSidebarTopBar';
import { MainTopBar } from '../components/topBars/MainTopBar';
import { RightSidebarTopBar } from '../components/topBars/RightSidebarTopBar';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';
import { getPlatformRuntime } from '../platform/runtime';

export function AppTopbar() {
  const runtime = getPlatformRuntime();
  // Topbar side sections always size to the minimum needed for their content,
  // regardless of whether the sidebars below them are open or wide. Earlier
  // the side sections matched the sidebar widths "for alignment", but with
  // a wide sidebar that wasted ~200px per side that could have been tabs.
  // Now the tabs take all remaining width and the side sections hug their
  // controls. Project-wide destinations live beside the left toggle; Copilot
  // now lives one level inside the account menu. The Bottom Timeline
  // toggle remains beside that dock's status line in the footer.
  // macOS needs room for its native window controls. Other desktop targets
  // and mobile keep only the product controls in this section.
  const leftWidth = runtime.isMobile ? 72 : runtime.isMacDesktop ? 288 : 216;
  return (
    <div
      className="app-topbar app-plane"
      style={{
        display: 'flex',
        width: '100%',
        height: 'var(--window-titlebar-height)',
        overflow: 'hidden',
      }}
    >
      {/* Left Section */}
      <div
        className="app-topbar__left"
        style={{
          width: leftWidth,
          borderRight: 'var(--chrome-divider)',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <LeftSidebarTopBar />
      </div>

      {/* Middle Section — takes all remaining space */}
      <div className="app-topbar__center" style={{ flex: 1, minWidth: 0, overflow: 'visible' }}>
        <MainTopBar>
          <TopTimeline />
        </MainTopBar>
      </div>

      {/* Right Section — auto-sized to its controls, no reserved pill space */}
      <div
        className="app-topbar__right"
        style={{
          borderLeft: 'var(--chrome-divider)',
          flexShrink: 0,
        }}
      >
        <RightSidebarTopBar />
      </div>
    </div>
  );
}
