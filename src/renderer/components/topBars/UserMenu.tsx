import { useSettingsPreloadIntent } from '../../features/settings/useSettingsPanels';
import { useEffect, useRef, useState } from 'react';
import {
  Sun,
  Moon,
  Monitor,
  Settings,
  Keyboard,
  Upload,
  BookOpenText,
  LogOut,
  Languages,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/auth';
import { useSettingsStore } from '../../store/settings-store';
import { events } from '../../lib/events';
import { UI_LOCALE_OPTIONS } from '../../lib/i18n';
import { useFeatureAccessStore } from '../../lib/feature-access';
import loglevel from 'loglevel';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { CopilotQuickSettings } from '../copilot/CopilotBottomMenu';
import { getPlatformRuntime } from '../../platform/runtime';
import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';

const log = loglevel.getLogger('UserMenu');

const PLAN_LABEL: Record<string, string> = {
  free: 'FREE',
  pro: 'PRO',
  studio: 'STUDIO',
};

interface UserMenuProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  scope?: 'project' | 'shelf';
}

type UserMenuSettingsPage = 'copilot';

export function UserMenu({ triggerRef, open, onClose, scope = 'project' }: UserMenuProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const plan = useFeatureAccessStore((s) => s.plan);
  const accountSettingsEnabled = hostedAccountSettingsEnabled();
  // Read the persisted mode (light/dark/system) — NOT the resolved ui-store
  // theme. The menu has to drive themeMode so that "跟随系统" actually
  // sticks; the resolver in App.tsx then writes back to ui-store.theme.
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const uiLocale = useSettingsStore((s) => s.uiLocale);
  const setUiLocale = useSettingsStore((s) => s.setUiLocale);
  const navigate = useNavigate();
  const settingsBackRef = useRef<HTMLButtonElement | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [activeSettingsPage, setActiveSettingsPage] = useState<UserMenuSettingsPage | null>(null);
  const settingsIntent = useSettingsPreloadIntent(open && activeSettingsPage === null);

  useEffect(() => {
    if (!open) setActiveSettingsPage(null);
  }, [open]);

  useEffect(() => {
    if (!open || activeSettingsPage === null) return undefined;
    const frame = window.requestAnimationFrame(() => {
      settingsBackRef.current?.focus({ preventScroll: true });
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setActiveSettingsPage(null);
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [activeSettingsPage, open]);

  const handleClose = () => {
    setActiveSettingsPage(null);
    onClose();
  };

  const openFullSettings = () => {
    if (getPlatformRuntime().isMobileShell) navigate('/settings?section=copilot');
    else events.emit('settings:open', { railId: 'copilot' });
    handleClose();
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      handleClose();
      navigate('/login');
    } catch (e) {
      log.error('Failed to sign out:', e);
      setSigningOut(false);
    }
  };

  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || t('common.local');
  const initial = displayName.charAt(0).toUpperCase();
  const normalizedUiLocale = uiLocale.startsWith('zh') ? 'zh-CN' : 'en';
  return (
    <AnchoredPopover
      anchorRef={triggerRef}
      open={open}
      onClose={handleClose}
      placement="bottom-end"
      role="dialog"
      ariaLabel={
        activeSettingsPage
          ? `${activeSettingsPage} settings`
          : t(accountSettingsEnabled ? 'userMenu.accountMenu' : 'userMenu.localMenu')
      }
      maxHeight={560}
      dismissOnEscape={activeSettingsPage === null}
      className={`menu-surface menu-surface--rich ${
        activeSettingsPage === 'copilot' ? 'menu-surface--panel' : 'menu-surface--wide'
      } user-menu`}
      style={{
        zIndex: 'var(--z-popover)',
        overflowY: 'auto',
      }}
    >
      {activeSettingsPage && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              minHeight: 38,
              padding: '4px 8px',
              borderBottom: '1px solid hsl(var(--rule))',
            }}
          >
            <button
              ref={settingsBackRef}
              type="button"
              onClick={() => setActiveSettingsPage(null)}
              aria-label={t('common.back', { defaultValue: 'Back' })}
              style={{
                width: 28,
                height: 28,
                display: 'grid',
                placeItems: 'center',
                padding: 0,
                border: 0,
                borderRadius: 2,
                background: 'transparent',
                color: 'hsl(var(--ink-3))',
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={15} strokeWidth={1.6} />
            </button>
            <span
              style={{
                marginLeft: 4,
                fontSize: 12.5,
                fontWeight: 500,
                color: 'hsl(var(--ink-1))',
              }}
            >
              Copilot
            </span>
          </div>
          <CopilotQuickSettings onOpenFullSettings={openFullSettings} />
        </div>
      )}

      <div style={{ display: activeSettingsPage ? 'none' : undefined }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 12px 10px',
            borderBottom: '1px solid hsl(var(--rule))',
          }}
        >
          <UserAvatar initial={initial} size={36} fontSize={17} />
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                fontSize: 14,
                color: 'hsl(var(--ink-1))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayName}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: 'hsl(var(--accent))',
                marginTop: 2,
              }}
            >
              {accountSettingsEnabled && user?.email
                ? `${PLAN_LABEL[plan] ?? plan.toUpperCase()} · BETA`
                : t('userMenu.localStatus')}
            </span>
          </div>
        </div>

        {scope === 'project' && (
          <MenuGroup>
            <MenuItem
              icon={<Sparkles size={13} />}
              label="Copilot"
              tail={<ChevronRight size={13} strokeWidth={1.6} />}
              onClick={() => setActiveSettingsPage('copilot')}
            />
          </MenuGroup>
        )}

        <MenuGroup last={scope === 'shelf' && !accountSettingsEnabled}>
          <MenuItem
            icon={
              themeMode === 'light' ? (
                <Sun size={13} />
              ) : themeMode === 'dark' ? (
                <Moon size={13} />
              ) : (
                <Monitor size={13} />
              )
            }
            label={t('userMenu.theme')}
            tail={
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  marginLeft: 'auto',
                  background: 'hsl(var(--paper-deep))',
                  borderRadius: 3,
                  padding: 1,
                }}
              >
                <ThemeSwitchBtn
                  active={themeMode === 'light'}
                  onClick={() => setThemeMode('light')}
                  title={t('userMenu.themeLight')}
                >
                  {t('userMenu.themeLightShort')}
                </ThemeSwitchBtn>
                <ThemeSwitchBtn
                  active={themeMode === 'dark'}
                  onClick={() => setThemeMode('dark')}
                  title={t('userMenu.themeDark')}
                >
                  {t('userMenu.themeDarkShort')}
                </ThemeSwitchBtn>
                <ThemeSwitchBtn
                  active={themeMode === 'system'}
                  onClick={() => setThemeMode('system')}
                  title={t('userMenu.themeSystem')}
                >
                  {t('userMenu.themeSystemShort')}
                </ThemeSwitchBtn>
              </div>
            }
          />
          <MenuItem
            icon={<Languages size={13} />}
            label={t('userMenu.language')}
            tail={
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  marginLeft: 'auto',
                  background: 'hsl(var(--paper-deep))',
                  borderRadius: 3,
                  padding: 1,
                }}
              >
                {UI_LOCALE_OPTIONS.map((locale) => (
                  <ThemeSwitchBtn
                    key={locale.code}
                    active={normalizedUiLocale === locale.code}
                    onClick={() => setUiLocale(locale.code)}
                    title={locale.name}
                  >
                    {locale.code === 'zh-CN' ? '中' : 'EN'}
                  </ThemeSwitchBtn>
                ))}
              </div>
            }
          />
          {scope === 'project' && (
            <>
              <MenuItem
                icon={<Settings size={13} />}
                label={t('userMenu.settings')}
                intent={settingsIntent}
                meta="⌘,"
                onClick={() => {
                  events.emit('settings:open', {});
                  handleClose();
                }}
              />
              <MenuItem
                icon={<Keyboard size={13} />}
                label={t('userMenu.keyboardShortcuts')}
                intent={settingsIntent}
                meta="⌘K ⌘/"
                onClick={() => {
                  events.emit('settings:open', { railId: 'keys' });
                  handleClose();
                }}
              />
            </>
          )}
          {scope === 'shelf' && (
            <MenuItem
              icon={<Settings size={13} />}
              label={t('userMenu.settings')}
              intent={settingsIntent}
              onClick={() => {
                navigate('/settings?section=sync', { state: { from: '/' } });
                handleClose();
              }}
            />
          )}
        </MenuGroup>

        {scope === 'project' && (
          <MenuGroup last>
            <>
              <MenuItem
                icon={<Upload size={13} />}
                label={t('userMenu.import')}
                meta="MD · DOCX · TXT"
                onClick={() => {
                  events.emit('import:open');
                  handleClose();
                }}
              />
              <MenuItem
                icon={<BookOpenText size={13} />}
                label={t('userMenu.bookshelf')}
                onClick={() => {
                  navigate('/');
                  handleClose();
                }}
              />
            </>
          </MenuGroup>
        )}

        {scope === 'shelf' && accountSettingsEnabled && (
          <MenuGroup last>
            <MenuItem
              icon={<LogOut size={13} />}
              label={signingOut ? t('userMenu.signingOut') : t('userMenu.signOut')}
              meta="SIGN OUT"
              onClick={signingOut ? undefined : handleSignOut}
            />
          </MenuGroup>
        )}
      </div>
    </AnchoredPopover>
  );
}

export function UserAvatar({
  initial,
  size = 24,
  fontSize = 12,
  onClick,
  forwardRef,
  title,
  expanded,
}: {
  initial: string;
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
      {initial}
    </button>
  );
}

function MenuGroup({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      className="user-menu__group"
      style={{
        borderBottom: last ? 'none' : '1px solid hsl(var(--rule))',
      }}
    >
      {children}
    </div>
  );
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
          width: 18,
          display: 'grid',
          placeItems: 'center',
          color: 'hsl(var(--ink-4))',
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
                fontSize: 9.5,
                color: 'hsl(var(--ink-4))',
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

function ThemeSwitchBtn({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.06em',
        padding: '3px 7px',
        borderRadius: 2,
        color: active ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
        background: active ? 'hsl(var(--surface))' : 'transparent',
        boxShadow: active ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        cursor: 'pointer',
        border: 0,
      }}
    >
      {children}
    </button>
  );
}
