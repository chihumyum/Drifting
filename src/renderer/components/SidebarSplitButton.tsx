import { useTranslation } from 'react-i18next';
import { useUiStore, type SidebarType } from '../store/ui-store';
import type { SidebarSplitEdge } from '../lib/sidebar-tabs';
import { BrushIcon } from './ui/BrushIcon';
import { GhostIconButton } from './ui/GhostIconButton';

/**
 * Shown once a sidebar is wide enough for two columns: a pair of hanging
 * scrolls at the end of the tab row where the second half will arrive, the
 * side of the half last closed. Each tab row renders one per end; only the
 * matching end shows.
 */
export function SidebarSplitButton({ side, edge }: { side: SidebarType; edge: SidebarSplitEdge }) {
  const { t } = useTranslation();
  const available = useUiStore((state) => {
    const layout = state.desktopSidebarTabs[side];
    return layout.canSplit && layout.panes.length === 1 && (layout.splitEdge ?? 'end') === edge;
  });
  const splitSidebar = useUiStore((state) => state.splitSidebar);
  if (!available) return null;
  return (
    <GhostIconButton
      size="lg"
      glass="round"
      className="sidebar-split-button"
      icon={<BrushIcon name="split" />}
      title={t('sidebarLayout.split')}
      aria-label={t('sidebarLayout.split')}
      onClick={() => splitSidebar(side)}
    />
  );
}
