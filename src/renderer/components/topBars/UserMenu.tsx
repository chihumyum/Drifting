import { useSettingsPreloadIntent } from '../../features/settings/useSettingsPanels';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/auth';
import { useSettingsStore } from '../../store/settings-store';
import { events } from '../../lib/events';
import { UI_LOCALE_OPTIONS } from '../../lib/i18n';
import loglevel from 'loglevel';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { getPlatformRuntime } from '../../platform/runtime';
import type { AnchoredPopoverPlacement } from '../ui/anchored-popover-position';
import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { useShareLinksDialogStore } from '../../features/share-links/share-links-dialog-store';
import { useFeedbackDialogStore } from '../../features/feedback/feedback-dialog-store';
import { useOpenSignIn } from '../../features/auth/auth-dialog-store';
import { requestSignOut } from '../../features/auth/sign-out';
import { AccountAvatar } from '../ui/AccountAvatar';
import { BrushIcon } from '../ui/BrushIcon';
import { GlassSelect } from '../ui/GlassSelect';
import { GlassSlider } from '../ui/GlassSlider';
import { platformShortcut } from '../../lib/shortcuts';

const log = loglevel.getLogger('UserMenu');

interface UserMenuProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  scope?: 'project' | 'shelf';
  /** Where the menu opens relative to its trigger. */
  placement?: AnchoredPopoverPlacement;
}

export function UserMenu({
  triggerRef,
  open,
  onClose,
  scope = 'project',
  placement = 'bottom-end',
}: UserMenuProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.hostedUser);
  const hostedStatus = useAuthStore((s) => s.hostedStatus);
  const canSignOut = hostedStatus === 'connected' || hostedStatus === 'offline' || hostedStatus === 'checking';
  const accountSettingsEnabled = hostedAccountSettingsEnabled();
  // Share links belong to the signed-in Hosted account.
  const shareLinksEnabled = accountSettingsEnabled && canSignOut;
  // Inside a book a Hosted build that is not signed in (it went on locally,
  // or the session ended) offers sign-in too; signing out stays on the shelf.
  const projectSignInShown = scope === 'project' && accountSettingsEnabled && !canSignOut;
  // Read the persisted mode (light/dark/system) — NOT the resolved ui-store
  // theme. The menu has to drive themeMode so that "跟随系统" actually
  // sticks; the resolver in App.tsx then writes back to ui-store.theme.
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const uiLocale = useSettingsStore((s) => s.uiLocale);
  const setUiLocale = useSettingsStore((s) => s.setUiLocale);
  const navigate = useNavigate();
  const openSignIn = useOpenSignIn();
  const [signingOut, setSigningOut] = useState(false);
  const settingsIntent = useSettingsPreloadIntent(scope === 'project' && open);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await requestSignOut(() => navigate('/'));
      onClose();
    } catch (e) {
      log.error('Failed to sign out:', e);
    } finally {
      setSigningOut(false);
    }
  };

  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || t('common.local');
  const initial = displayName.charAt(0).toUpperCase();
  const normalizedUiLocale = uiLocale;
  // A phone has no hardware keyboard to speak of: no shortcut hints and no
  // keyboard-shortcuts row on the mobile shell.
  const keyboard = !getPlatformRuntime().isMobileShell;
  return (
    <AnchoredPopover
      anchorRef={triggerRef}
      open={open}
      onClose={onClose}
      placement={placement}
      role="dialog"
      ariaLabel={t(accountSettingsEnabled ? 'userMenu.accountMenu' : 'userMenu.localMenu')}
      maxHeight={560}
      className="menu-surface menu-surface--rich menu-surface--wide user-menu"
      style={{
        zIndex: 'var(--z-popover)',
        overflowY: 'auto',
      }}
    >
      <div>
        <div className="user-menu__head">
          <UserAvatar initial={initial} image={user?.image} size={32} fontSize={15} />
          <div className="user-menu__identity">
            <span className="user-menu__name">{displayName}</span>
            <span className="user-menu__status">
              {accountSettingsEnabled && user?.email
                ? t(`settings.hosted.session.${hostedStatus}`)
                : t('userMenu.localStatus')}
            </span>
          </div>
        </div>

        <MenuGroup last={scope === 'shelf' && !accountSettingsEnabled}>
          <MenuItem
            icon={
              <BrushIcon
                name={themeMode === 'light' ? 'enso' : themeMode === 'dark' ? 'ink-disc' : 'taiji'}
                size={16}
              />
            }
            label={t('userMenu.theme')}
            tail={
              <GlassSlider
                className="user-menu__slider"
                ariaLabel={t('userMenu.theme')}
                value={themeMode}
                onChange={setThemeMode}
                options={[
                  { value: 'light', label: t('userMenu.themeLightShort'), title: t('userMenu.themeLight') },
                  { value: 'dark', label: t('userMenu.themeDarkShort'), title: t('userMenu.themeDark') },
                  { value: 'system', label: t('userMenu.themeSystemShort'), title: t('userMenu.themeSystem') },
                ]}
              />
            }
          />
          <MenuItem
            icon={<BrushIcon name="wen" size={16} />}
            label={t('userMenu.language')}
            tail={
              <GlassSelect
                value={normalizedUiLocale}
                onChange={setUiLocale}
                ariaLabel={t('userMenu.language')}
                options={UI_LOCALE_OPTIONS.map((locale) => ({
                  value: locale.code,
                  label: locale.native,
                }))}
              />
            }
          />
          {scope === 'project' && (
            <>
              <MenuItem
                icon={<BrushIcon name="dharma-wheel" size={16} />}
                label={t('userMenu.settings')}
                intent={settingsIntent}
                meta={keyboard ? platformShortcut('⌘,', 'Ctrl+,') : undefined}
                onClick={() => {
                  events.emit('settings:open', {});
                  onClose();
                }}
              />
              {keyboard && (
                <MenuItem
                  icon={<BrushIcon name="movable-type" size={16} />}
                  label={t('userMenu.keyboardShortcuts')}
                  intent={settingsIntent}
                  meta={platformShortcut('⌘K ⌘/', 'Ctrl+K Ctrl+/')}
                  onClick={() => {
                    events.emit('settings:open', { railId: 'keys' });
                    onClose();
                  }}
                />
              )}
            </>
          )}
          {scope === 'shelf' && (
            <MenuItem
              icon={<BrushIcon name="dharma-wheel" size={16} />}
              label={t('userMenu.settings')}
              intent={settingsIntent}
              onClick={() => {
                navigate('/settings?section=sync', { state: { from: '/' } });
                onClose();
              }}
            />
          )}
          <MenuItem
            icon={<BrushIcon name="sticky-note" size={16} />}
            label={t('userMenu.feedback')}
            onClick={() => {
              useFeedbackDialogStore.getState().show();
              onClose();
            }}
          />
        </MenuGroup>

        {scope === 'project' && (
          <MenuGroup last={!projectSignInShown}>
            <>
              {shareLinksEnabled && (
                <MenuItem
                  icon={<BrushIcon name="share" size={16} />}
                  label={t('shareLink.listTitle')}
                  onClick={() => {
                    useShareLinksDialogStore.getState().show();
                    onClose();
                  }}
                />
              )}
              <MenuItem
                icon={<BrushIcon name="case-dew" size={16} />}
                label={t('userMenu.import')}
                meta="MD · DOCX · TXT"
                onClick={() => {
                  events.emit('import:open');
                  onClose();
                }}
              />
              <MenuItem
                icon={<BrushIcon name="books" size={16} />}
                label={t('userMenu.bookshelf')}
                onClick={() => {
                  navigate('/');
                  onClose();
                }}
              />
            </>
          </MenuGroup>
        )}

        {projectSignInShown && (
          <MenuGroup last>
            <MenuItem
              icon={<BrushIcon name="gate-in" size={16} />}
              label={t('settings.hosted.sign_in_sync')}
              onClick={() => { onClose(); openSignIn(); }}
            />
          </MenuGroup>
        )}

        {scope === 'shelf' && accountSettingsEnabled && (
          <MenuGroup last>
            {shareLinksEnabled && (
              <MenuItem
                icon={<BrushIcon name="share" size={16} />}
                label={t('shareLink.listTitle')}
                onClick={() => {
                  useShareLinksDialogStore.getState().show();
                  onClose();
                }}
              />
            )}
            <MenuItem
              icon={<BrushIcon name={canSignOut ? 'gate-out' : 'gate-in'} size={16} />}
              label={signingOut ? t('userMenu.signingOut') : t(canSignOut ? 'userMenu.signOut' : 'settings.hosted.sign_in_sync')}
              onClick={signingOut ? undefined : canSignOut ? handleSignOut : () => { onClose(); openSignIn(); }}
            />
          </MenuGroup>
        )}
      </div>
    </AnchoredPopover>
  );
}

export function UserAvatar({
  initial,
  image,
  size = 24,
  fontSize = 12,
  onClick,
  forwardRef,
  title,
  expanded,
}: {
  initial: string;
  image?: string | null;
  size?: number;
  fontSize?: number;
  onClick?: () => void;
  forwardRef?: React.Ref<HTMLButtonElement>;
  title?: string;
  expanded?: boolean;
}) {
  return (
    <button
      ref={forwardRef}
      type="button"
      onClick={onClick}
      title={title}
      aria-expanded={expanded}
      aria-haspopup={onClick ? 'dialog' : undefined}
      style={
        {
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, hsl(var(--story-1)), hsl(var(--story-5)))',
          color: 'hsl(var(--paper))',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-sans)',
          fontStyle: 'italic',
          fontSize,
          fontWeight: 500,
          cursor: onClick ? 'pointer' : 'default',
          border: 'none',
          padding: 0,
          flexShrink: 0,
        } as React.CSSProperties
      }
    >
      <AccountAvatar image={image} initial={initial} />
    </button>
  );
}

/** Groups are parted by space. */
function MenuGroup({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return <div className={`user-menu__group${last ? ' user-menu__group--last' : ''}`}>{children}</div>;
}

interface MenuItemProps {
  intent?: ReturnType<typeof useSettingsPreloadIntent>;
  icon: React.ReactNode;
  label: string;
  meta?: string;
  tail?: React.ReactNode;
  onClick?: () => void;
}

function MenuItem({ icon, label, meta, tail, onClick, intent }: MenuItemProps) {
  const content = (
    <>
      <span
        style={{
          width: 16,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflowWrap: 'anywhere',
        }}
      >
        {label}
      </span>
      {tail
        ? tail
        : meta && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--ui-font-caption, 9.5px)',
                color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
                marginLeft: 'auto',
              }}
            >
              {meta}
            </span>
          )}
    </>
  );
  const className = `menu-surface__item user-menu__item${
    onClick ? '' : ' user-menu__item--static'
  }`;
  const style: React.CSSProperties = {
    gap: 10,
    cursor: onClick ? 'pointer' : 'default',
  };

  return onClick ? (
    <button
      {...intent} type="button" onClick={onClick} className={className} style={style}>
      {content}
    </button>
  ) : (
    <div className={className} style={style}>
      {content}
    </div>
  );
}
