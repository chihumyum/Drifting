import { Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { events } from '../../lib/events.ts';
import { useUiStore } from '../../store/ui-store';
import { getPlatformRuntime } from '../../platform/runtime';

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
          height: 42,
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
      <GhostIconBtn
        onClick={handleOpenSearch}
        title={t('leftSidebar.top.search')}
        marginLeft={isLeftSidebarOpen ? 'auto' : undefined}
        icon={<Search size={iconSize} strokeWidth={1.6} />}
      />
      <GhostIconBtn
        onClick={handleToggleLeftSidebar}
        title={isLeftSidebarOpen ? t('leftSidebar.top.close') : t('leftSidebar.top.open')}
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

interface GhostIconBtnProps {
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
  marginLeft?: number | 'auto';
}

function GhostIconBtn({ onClick, title, icon, marginLeft }: GhostIconBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          cursor: 'pointer',
          transition: 'background 0.15s ease, color 0.15s ease',
          padding: 0,
          marginLeft,
        } as React.CSSProperties
      }
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--paper-deep))';
        e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'hsl(var(--ink-3))';
      }}
    >
      {icon}
    </button>
  );
}
