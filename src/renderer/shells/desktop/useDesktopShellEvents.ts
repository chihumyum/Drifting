import { useEffect } from 'react';
import { events } from '../../lib/events';
import { useUiStore } from '../../store/ui-store';

interface DesktopShellEventHandlers {
  openSettings(railId: string | null): void;
  openImport(): void;
  openSearch(): void;
}

export function useDesktopShellEvents({
  openSettings,
  openImport,
  openSearch,
}: DesktopShellEventHandlers) {
  useEffect(() => {
    const handleOpenSettings = (payload?: { railId?: string }) => {
      openSettings(payload?.railId ?? null);
    };
    const handleToggleLeftSidebar = () => useUiStore.getState().toggleSidebar('left');
    const handleToggleRightSidebar = () => useUiStore.getState().toggleSidebar('right');
    events.on('settings:open', handleOpenSettings);
    events.on('import:open', openImport);
    events.on('search:open', openSearch);
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    events.on('right-sidebar:toggle', handleToggleRightSidebar);

    return () => {
      events.off('settings:open', handleOpenSettings);
      events.off('import:open', openImport);
      events.off('search:open', openSearch);
      events.off('left-sidebar:toggle', handleToggleLeftSidebar);
      events.off('right-sidebar:toggle', handleToggleRightSidebar);
    };
  }, [openImport, openSearch, openSettings]);
}
