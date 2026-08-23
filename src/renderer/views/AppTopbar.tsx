import { LeftSidebarTopBar } from '../components/topBars/LeftSidebarTopBar';
import { MainTopBar } from '../components/topBars/MainTopBar';
import { RightSidebarTopBar } from '../components/topBars/RightSidebarTopBar';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';
import { getPlatformRuntime } from '../platform/runtime';

export function AppTopbar() {
  const runtime = getPlatformRuntime();
  // Topbar side sections remain independent from the resizable sidebars below.
  // Earlier they matched those sidebar widths "for alignment", which could
  // waste ~200px per side that should remain available to tabs. Both side
  // sections now hug their actual content, so project identity, commands and
  // tabs close up naturally instead of aligning to an invented column width.
  // Project-wide destinations live beside the left toggle; Copilot lives one
  // level inside the account menu. The Bottom Timeline toggle remains beside
  // that dock's status line in the footer.
  // macOS needs room for its native window controls and a stable current-project
  // identity. The name itself owns the only capped, shrinkable slot; the
  // surrounding section is intrinsic-width and the command group stays fixed.
  // Mobile keeps only its product controls.
  const leftWidth = runtime.isMobile ? 72 : 'max-content';
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
