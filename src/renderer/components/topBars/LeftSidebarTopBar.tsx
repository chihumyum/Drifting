import { ArrowLeft, Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { events } from '../../lib/events.ts';
import { useProjectStore } from '../../store/project-store';
import { useUiStore } from '../../store/ui-store';
import { getPlatformRuntime } from '../../platform/runtime';
import { GhostIconButton } from '../ui/GhostIconButton';
import { WorkspaceNavigationButtons } from './WorkspaceNavigationButtons';

export function LeftSidebarTopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runtime = getPlatformRuntime();
  const projectName = useProjectStore((state) => state.currentProject?.name.trim() ?? '');
  const isLeftSidebarOpen = useUiStore((state) => state.sidebars.left.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  const handleOpenSearch = () => events.emit('search:open');
  const handleToggleLeftSidebar = () => toggleSidebar('left');
  const handleBackToShelf = () => navigate('/');

  const iconSize = 16;

  return (
    <div
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      style={
        {
          height: 'var(--window-titlebar-height)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: runtime.isMacDesktop ? 'var(--window-header-leading-inset)' : 8,
          paddingRight: 8,
          flexShrink: 0,
          borderBottom: '1px solid hsl(var(--rule))',
          width: '100%',
          gap: 8,
        } as React.CSSProperties
      }
    >
      {/* macOS native controls and product actions share this section; on
          other targets the actions start at the ordinary content inset. */}
      {!runtime.isMobileShell && projectName && (
        <button
          type="button"
          className="app-topbar__project-return"
          data-tauri-drag-region="false"
          onClick={handleBackToShelf}
          title={`${t('projectPicker.backToShelf')} · ${projectName}`}
          aria-label={`${t('projectPicker.backToShelf')} · ${projectName}`}
        >
          <span className="app-topbar__project-name">{projectName}</span>
          <span className="app-topbar__project-return-layer" aria-hidden="true">
            <span className="app-topbar__project-return-content">
              <ArrowLeft size={16} strokeWidth={1.6} />
              <span className="app-topbar__project-return-label">
                {t('projectPicker.bookshelfShort')}
              </span>
            </span>
          </span>
        </button>
      )}
      <div className="app-topbar__left-actions">
        <GhostIconButton
          onClick={handleOpenSearch}
          title={t('leftSidebar.top.search')}
          aria-label={t('leftSidebar.top.search')}
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
        <WorkspaceNavigationButtons />
      </div>
    </div>
  );
}
