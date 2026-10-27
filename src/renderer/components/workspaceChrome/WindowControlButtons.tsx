import type { ReactNode } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore, type SidebarType } from '../../store/ui-store';
import { GhostIconButton } from '../ui/GhostIconButton';

// The workspace has no title bar. Each sidebar's toggle stays in its own top
// corner: on the desk while the sidebar is closed, at the outer end of the
// sidebar's tab row while it is open. Global search is keyboard-only.

export function SidebarToggleButton({ side }: { side: SidebarType }) {
  const { t } = useTranslation();
  const isOpen = useUiStore((state) => state.sidebars[side].isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const label = t(`${side === 'left' ? 'leftSidebar' : 'rightSidebar'}.top.${isOpen ? 'close' : 'open'}`);
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <GhostIconButton
      onClick={() => toggleSidebar(side)}
      title={label}
      aria-label={label}
      icon={<Icon size={16} strokeWidth={1.6} />}
    />
  );
}

/** Controls a sidebar header row absorbs; measured into the sidebar minimum. */
export function SidebarHeaderChrome({ side, children }: { side: SidebarType; children: ReactNode }) {
  return (
    <div data-sidebar-header-chrome={side} className={`sidebar-header-chrome sidebar-header-chrome--${side}`}>
      {children}
    </div>
  );
}
