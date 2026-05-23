import { useUiStore } from '../store/ui-store';
import { LeftSidebarTopBar } from '../components/topBars/LeftSidebarTopBar';
import { MainTopBar } from '../components/topBars/MainTopBar';
import { RightSidebarTopBar } from '../components/topBars/RightSidebarTopBar';
import { NewEntityButton } from '../components/topBars/TopTimeline/NewEntityButton';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';

interface AppTopbarProps {
  hideNewEntityButton?: boolean;
}

export function AppTopbar({ hideNewEntityButton = false }: AppTopbarProps) {
  const leftState = useUiStore((s) => s.sidebars.left);
  const rightState = useUiStore((s) => s.sidebars.right);

  const resizingSidebar = useUiStore((s) => s.resizingSidebar);

  // Calculate widths
  // Collapsed left section just hosts the two buttons hugging the traffic lights:
  // paddingLeft 78 (traffic lights) + search 26 + gap 2 + toggle 26 + paddingRight 8 = 140
  const LEFT_COLLAPSED_WIDTH = 140;
  // Collapsed right section must fit the sidebar-toggle button (26px) and the
  // always-visible user avatar (26px), plus paddings + gap (~22px).
  const RIGHT_COLLAPSED_WIDTH = 80;

  const leftWidth = leftState.isOpen ? leftState.width : LEFT_COLLAPSED_WIDTH;
  const rightWidth = rightState.isOpen ? rightState.width : RIGHT_COLLAPSED_WIDTH;

  return (
    <div style={{ display: 'flex', width: '100%', height: 42, overflow: 'hidden' }}>
      {/* Left Section */}
      <div
        style={{
          width: leftWidth,
          transition: resizingSidebar === 'left' ? 'none' : 'width 0.2s',
          borderRight: '1px solid hsl(var(--rule))',
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
          transition: resizingSidebar === 'right' ? 'none' : 'width 0.2s',
          borderLeft: '1px solid hsl(var(--rule))',
          flexShrink: 0,
        }}
      >
        <RightSidebarTopBar />
      </div>
    </div>
  );
}
