import { Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { events } from '../../lib/events.ts';
import { useUiStore } from '../../store/ui-store';
import { getPlatformRuntime } from '../../platform/runtime';
import { GhostIconButton } from '../ui/GhostIconButton';

export function LeftSidebarTopBar() {
  const { t } = useTranslation();
  const runtime = getPlatformRuntime();
  const isLeftSidebarOpen = useUiStore((state) => state.sidebars.left.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  const handleOpenSearch = () => events.emit('search:open');
  const handleToggleLeftSidebar = () => toggleSidebar('left');

  const iconSize = 16;

  return (
    <div
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      style={
        {
          height: 'var(--window-titlebar-height)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: runtime.isMacDesktop ? 78 : 8,
          paddingRight: 8,
          flexShrink: 0,
          borderBottom: '1px solid hsl(var(--rule))',
          width: '100%',
          gap: 2,
        } as React.CSSProperties
      }
    >
      {/* macOS native controls and product actions share this section; on
          other targets the actions start at the ordinary content inset. */}
      <GhostIconButton
        onClick={handleOpenSearch}
        title={t('leftSidebar.top.search')}
        aria-label={t('leftSidebar.top.search')}
        style={{ marginLeft: isLeftSidebarOpen ? 'auto' : undefined }}
        icon={<Search size={iconSize} strokeWidth={1.6} />}
      />
      <GhostIconButton
        onClick={handleToggleLeftSidebar}
        title={isLeftSidebarOpen ? t('leftSidebar.top.close') : t('leftSidebar.top.open')}
        aria-label={isLeftSidebarOpen ? t('leftSidebar.top.close') : t('leftSidebar.top.open')}
        icon={
          isLeftSidebarOpen ? (
            <PanelLeftClose size={iconSize} strokeWidth={1.6} />
          ) : (
            <PanelLeftOpen size={iconSize} strokeWidth={1.6} />
          )
        }
      />
    </div>
  );
}
