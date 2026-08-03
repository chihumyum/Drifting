import { useRef, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { UserAvatar, UserMenu } from './UserMenu';
import { NotificationPill } from '../notifications/NotificationPill';
import { getPlatformRuntime } from '../../platform/runtime';
import { GhostIconButton } from '../ui/GhostIconButton';
import { CopilotQuickMenu } from '../copilot/CopilotBottomMenu';
import { ShadowQuickMenu } from '../ShadowQuickMenu';

export function RightSidebarTopBar() {
  const { desktopWindowControls } = getPlatformRuntime();
  const isRightSidebarOpen = useUiStore((state) => state.sidebars.right.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const iconSize = 16;
  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || 'L';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      data-tauri-drag-region={desktopWindowControls ? 'deep' : undefined}
      style={
        {
          height: 'var(--window-titlebar-height)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 6,
          paddingRight: 8,
          gap: 2,
          borderBottom: '1px solid hsl(var(--rule))',
          width: '100%',
        } as React.CSSProperties
      }
    >
      <div className="app-topbar__quick-actions">
        <CopilotQuickMenu />
        <ShadowQuickMenu />
      </div>
      <NotificationPill />
      <GhostIconButton
        onClick={() => toggleSidebar('right')}
        title={isRightSidebarOpen ? 'Close Right Sidebar' : 'Open Right Sidebar'}
        aria-label={isRightSidebarOpen ? 'Close Right Sidebar' : 'Open Right Sidebar'}
        icon={
          isRightSidebarOpen ? (
            <PanelRightClose size={iconSize} strokeWidth={1.6} />
          ) : (
            <PanelRightOpen size={iconSize} strokeWidth={1.6} />
          )
        }
      />
      <UserAvatar
        forwardRef={avatarRef}
        initial={initial}
        size={26}
        fontSize={13}
        title={displayName}
        onClick={() => setMenuOpen((v) => !v)}
        expanded={menuOpen}
      />
      <UserMenu triggerRef={avatarRef} open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  );
}
