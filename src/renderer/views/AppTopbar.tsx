import { LeftSidebarTopBar } from '../components/topBars/LeftSidebarTopBar';
import { MainTopBar } from '../components/topBars/MainTopBar';
import { RightSidebarTopBar } from '../components/topBars/RightSidebarTopBar';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';

export function AppTopbar() {
  // Topbar side sections always size to the minimum needed for their content,
  // regardless of whether the sidebars below them are open or wide. Earlier
  // the side sections matched the sidebar widths "for alignment", but with
  // a wide sidebar that wasted ~200px per side that could have been tabs.
  // Now the tabs take all remaining width and the side sections hug their
  // controls — search + toggle on the left, toggle + avatar on the right.
  // paddingLeft 78 (traffic lights) + search 26 + gap 2 + toggle 26 + paddingRight 8 = 140
  const leftWidth = 140;
  // paddingLeft 6 + leading spacer + pill (≤150) + gap 6 + toggle 26 + gap 6 +
  // avatar 26 + paddingRight 8. Reserve room for the expanded notification pill;
  // when idle the pill is a 26px bell and the leading spacer absorbs the slack so
  // the toggle + avatar stay flush right.
  const rightWidth = 226;

  return (
    <div
      className="app-chrome app-island"
      style={{
        display: 'flex',
        width: '100%',
        height: 42,
        overflow: 'hidden',
        background: 'var(--chrome-bg)',
      }}
    >
      {/* Left Section */}
      <div
        style={{
          width: leftWidth,
          borderRight: 'var(--chrome-divider)',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <LeftSidebarTopBar />
      </div>

      {/* Middle Section */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'visible' }}>
        <MainTopBar>
          <TopTimeline />
        </MainTopBar>
      </div>

      {/* Right Section */}
      <div
        style={{
          width: rightWidth,
          borderLeft: 'var(--chrome-divider)',
          flexShrink: 0,
        }}
      >
        <RightSidebarTopBar />
      </div>
    </div>
  );
}
