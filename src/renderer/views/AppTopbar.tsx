import { LeftSidebarTopBar } from '../components/topBars/LeftSidebarTopBar';
import { MainTopBar } from '../components/topBars/MainTopBar';
import { RightSidebarTopBar } from '../components/topBars/RightSidebarTopBar';
import { NewEntityButton } from '../components/topBars/TopTimeline/NewEntityButton';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';

interface AppTopbarProps {
  hideNewEntityButton?: boolean;
}

export function AppTopbar({ hideNewEntityButton = false }: AppTopbarProps) {
  // Topbar side sections always size to the minimum needed for their content,
  // regardless of whether the sidebars below them are open or wide. Earlier
  // the side sections matched the sidebar widths "for alignment", but with
  // a wide sidebar that wasted ~200px per side that could have been tabs.
  // Now the tabs take all remaining width and the side sections hug their
  // controls — search + toggle on the left, toggle + avatar on the right.
  // paddingLeft 78 (traffic lights) + search 26 + gap 2 + toggle 26 + paddingRight 8 = 140
  const leftWidth = 140;
  // paddingLeft 6 + toggle 26 + gap 6 + spacer ~8 + avatar 26 + paddingRight 8 = 80
  const rightWidth = 80;

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
        <MainTopBar rightContent={hideNewEntityButton ? undefined : <NewEntityButton />}>
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
