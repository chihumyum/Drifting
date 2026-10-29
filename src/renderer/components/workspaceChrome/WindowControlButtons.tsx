import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getPlatformRuntime } from '../../platform/runtime';
import { useUiStore, type SidebarType } from '../../store/ui-store';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';

// The workspace has no title bar. Each sidebar's toggle is a round glass
// button fixed in its own top corner: it never moves, and the sidebar slides
// in and out underneath it like a drawer. While the sidebar is open, its tab
// row keeps an empty slot under the toggle. Its crescent is inked while the
// sidebar is open and hollow while it is closed; closed, it floats over the
// desk and wears the resting glass line on the floating fill, like the
// paper's toolbar. Global search is keyboard-only.

export function SidebarToggleButton({ side }: { side: SidebarType }) {
  const { t } = useTranslation();
  const isOpen = useUiStore((state) => state.sidebars[side].isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const label = t(`${side === 'left' ? 'leftSidebar' : 'rightSidebar'}.top.${isOpen ? 'close' : 'open'}`);
  return (
    <GhostIconButton
      size="lg"
      glass="round"
      className={`workspace-sidebar-toggle workspace-sidebar-toggle--${side}${isOpen ? '' : ' workspace-sidebar-toggle--floating glass--rest'}`}
      onClick={() => toggleSidebar(side)}
      title={label}
      aria-label={label}
      icon={<BrushIcon name={`moon-${side}${isOpen ? '' : '-hollow'}`} />}
    />
  );
}

/** Both sidebar toggles, above the three columns. */
export function WorkspaceSidebarToggles() {
  const runtime = getPlatformRuntime();
  return (
    <div className="workspace-sidebar-toggles" data-leading-inset={runtime.isMacDesktop ? 'true' : undefined}>
      <SidebarToggleButton side="left" />
      <SidebarToggleButton side="right" />
    </div>
  );
}

/** The room a sidebar's tab row leaves under its fixed toggle. */
export function SidebarToggleSlot() {
  return <span className="sidebar-toggle-slot" aria-hidden="true" />;
}

/** Controls a sidebar header row absorbs; measured into the sidebar minimum. */
export function SidebarHeaderChrome({ side, children }: { side: SidebarType; children: ReactNode }) {
  return (
    <div data-sidebar-header-chrome={side} className={`sidebar-header-chrome sidebar-header-chrome--${side}`}>
      {children}
    </div>
  );
}
