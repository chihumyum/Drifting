import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isProjectHomePathname } from '../../features/workspace/navigation/workspace-route';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useUiStore } from '../../store/ui-store';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useAuthStore } from '../../store/auth';
import { NotificationPill } from '../notifications/NotificationPill';
import { UserMenu } from '../topBars/UserMenu';
import { AccountAvatar } from '../ui/AccountAvatar';

/**
 * The account and the remaining workspace-wide controls live in one cell at
 * the foot of the left sidebar, shown only while that sidebar is open: the
 * account menu, Project Home and notifications. The account menu and the
 * notification center open upward from it.
 */
export function WorkspaceAccountCell() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.hostedUser);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { projectId, navigateToHome } = useProjectNavigation();
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);
  const homeActive = activeSuperView === 'none' && isProjectHomePathname(projectId, location.pathname);
  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || t('common.local');
  return (
    <div className="sidebar-account-cell">
      <button
        ref={triggerRef}
        type="button"
        className="sidebar-account-cell__account"
        title={displayName}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="sidebar-account-cell__avatar" aria-hidden="true">
          <AccountAvatar image={user?.image} initial={displayName.charAt(0).toUpperCase()} />
        </span>
        <span className="sidebar-account-cell__name">{displayName}</span>
      </button>
      <GhostIconButton
        glass="round"
        aria-pressed={homeActive}
        title={t('bottomStatusBar.projectHome')}
        aria-label={t('bottomStatusBar.projectHome')}
        onClick={() => {
          setActiveSuperView('none');
          navigateToHome();
        }}
        icon={<BrushIcon name="torii" />}
      />
      <NotificationPill opens="up" />
      <UserMenu triggerRef={triggerRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="top-start" />
      <span className="flow-line flow-line--h sidebar-account-cell__flow" aria-hidden="true" />
    </div>
  );
}
