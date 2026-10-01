import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore, type SidebarType } from '../store/ui-store';
import { GhostIconButton } from './ui/GhostIconButton';

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
      icon={<Columns2 size={14} />}
      title={t('sidebarLayout.split')}
      aria-label={t('sidebarLayout.split')}
      onClick={() => splitSidebar(side)}
    />
  );
}
