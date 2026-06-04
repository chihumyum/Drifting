import { useRef, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { UserAvatar, UserMenu } from './UserMenu';
import { NotificationPill } from '../notifications/NotificationPill';

export function RightSidebarTopBar() {
  const isMac = navigator.userAgent.includes('Mac');
  const isRightSidebarOpen = useUiStore((state) => state.sidebars.right.isOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!isMac) {
    return null;
  }

  const iconSize = 16;
  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || 'L';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      style={
        {
          height: 42,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 6,
          paddingRight: 8,
          gap: 6,
          borderBottom: '1px solid hsl(var(--rule))',
          width: '100%',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
    >
      {/* Leading spacer keeps the whole control cluster (pill · toggle · avatar)
          flush to the window's right edge, with empty drag space on the left. */}
      <div style={{ flex: 1 }} />
      {/* Dynamic-Island AI-task pill, sitting just left of the sidebar toggle. */}
      <NotificationPill />
      <button
        onClick={() => toggleSidebar('right')}
        title={isRightSidebarOpen ? 'Close Right Sidebar' : 'Open Right Sidebar'}
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
            WebkitAppRegion: 'no-drag',
            padding: 0,
            flexShrink: 0,
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
        {isRightSidebarOpen ? (
          <PanelRightClose size={iconSize} strokeWidth={1.6} />
        ) : (
          <PanelRightOpen size={iconSize} strokeWidth={1.6} />
        )}
      </button>
      <UserAvatar
        forwardRef={avatarRef}
        initial={initial}
        size={26}
        fontSize={13}
        title={displayName}
        onClick={() => setMenuOpen((v) => !v)}
      />
      <UserMenu triggerRef={avatarRef} open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  );
}
