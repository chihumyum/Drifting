import { useTranslation } from 'react-i18next';
import { useUiStore, type SidebarType } from '../store/ui-store';
import { BrushIcon } from './ui/BrushIcon';
import { GhostIconButton } from './ui/GhostIconButton';

/** Shown once a sidebar is wide enough for two columns: a pair of hanging scrolls. */
export function SidebarSplitButton({ side }: { side: SidebarType }) {
  const { t } = useTranslation();
  const available = useUiStore((state) => {
    const layout = state.desktopSidebarTabs[side];
    return layout.canSplit && layout.panes.length === 1;
  });
  const splitSidebar = useUiStore((state) => state.splitSidebar);
  if (!available) return null;
  return (
    <GhostIconButton
      size="lg"
      glass="round"
      icon={<BrushIcon name="split" />}
      title={t('sidebarLayout.split')}
      aria-label={t('sidebarLayout.split')}
      onClick={() => splitSidebar(side)}
    />
  );
}
