import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sun,
  Moon,
  Monitor,
  Settings,
  Keyboard,
  Upload,
  BookOpenText,
  CircleDot,
  HelpCircle,
  Palette,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { useSettingsStore } from '../../store/settings-store';
import { events } from '../../lib/events';
import { useFeatureAccessStore } from '../../lib/feature-access';

const PLAN_LABEL: Record<string, string> = {
  free: 'FREE',
  pro: 'PRO',
  studio: 'STUDIO',
};

interface UserMenuProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

export function UserMenu({ triggerRef, open, onClose }: UserMenuProps) {
  const user = useAuthStore((s) => s.user);
  const plan = useFeatureAccessStore((s) => s.plan);
  // Read the persisted mode (light/dark/system) — NOT the resolved ui-store
  // theme. The menu has to drive themeMode so that "跟随系统" actually
  // sticks; the resolver in App.tsx then writes back to ui-store.theme.
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const appearanceSkin = useSettingsStore((s) => s.appearanceSkin);
  const setAppearanceSkin = useSettingsStore((s) => s.setAppearanceSkin);
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) triggerRef.current?.blur();
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      triggerRef.current?.blur();
      onClose();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open, onClose, triggerRef]);

  if (!open || !position) return null;

  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || 'Local';
  const initial = displayName.charAt(0).toUpperCase();

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 290 } as React.CSSProperties}
      />
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          top: position.top,
          right: position.right,
          width: 248,
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 6,
          boxShadow: '0 10px 28px hsl(var(--ink-1) / 0.15), 0 2px 6px hsl(var(--ink-1) / 0.08)',
          zIndex: 300,
          fontFamily: 'var(--font-sans)',
          overflow: 'hidden',
          animation: 'userMenuIn 180ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <style>{`
          @keyframes userMenuIn {
            from { opacity: 0; transform: translateY(-6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>

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
                fontFamily: 'var(--font-serif)',
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
              {user?.email ? `${PLAN_LABEL[plan] ?? plan.toUpperCase()} · BETA` : 'LOCAL'}
            </span>
          </div>
        </div>

        <MenuGroup>
          <MenuItem
            icon={<Palette size={13} />}
            label="外观"
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
                  active={appearanceSkin === 'classic'}
                  onClick={() => setAppearanceSkin('classic')}
                  title="经典 · 文学手稿风"
                >
                  经典
                </ThemeSwitchBtn>
                <ThemeSwitchBtn
                  active={appearanceSkin === 'modern'}
                  onClick={() => setAppearanceSkin('modern')}
                  title="现代 · Craft / Arc 风（Preview）"
                >
                  现代
                </ThemeSwitchBtn>
              </div>
            }
          />
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
            label="主题"
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
                  title="浅色"
                >
                  明
                </ThemeSwitchBtn>
                <ThemeSwitchBtn
                  active={themeMode === 'dark'}
                  onClick={() => setThemeMode('dark')}
                  title="深色"
                >
                  暗
                </ThemeSwitchBtn>
                <ThemeSwitchBtn
                  active={themeMode === 'system'}
                  onClick={() => setThemeMode('system')}
                  title="跟随系统"
                >
                  系统
                </ThemeSwitchBtn>
              </div>
            }
          />
          <MenuItem
            icon={<Settings size={13} />}
            label="设定"
            meta="⌘,"
            onClick={() => {
              events.emit('settings:open', {});
              onClose();
            }}
          />
          <MenuItem
            icon={<Keyboard size={13} />}
            label="键盘快捷键"
            meta="⌘K ⌘/"
            onClick={() => {
              events.emit('settings:open', { railId: 'keys' });
              onClose();
            }}
          />
        </MenuGroup>

        <MenuGroup>
          <MenuItem
            icon={<Upload size={13} />}
            label="导入"
            meta="MD · DOCX · TXT"
            onClick={() => {
              events.emit('import:open');
              onClose();
            }}
          />
          <MenuItem
            icon={<BookOpenText size={13} />}
            label="书架 · 切换项目"
            onClick={() => {
              navigate('/');
              onClose();
            }}
          />
          <MenuItem icon={<CircleDot size={13} />} label="Shadow 用量" meta="12 / 50 任务" />
        </MenuGroup>

        <MenuGroup last>
          <MenuItem icon={<HelpCircle size={13} />} label="帮助 · 反馈" />
        </MenuGroup>
      </div>
    </>,
    document.body,
  );
}

export function UserAvatar({
  initial,
  size = 24,
  fontSize = 12,
  onClick,
  forwardRef,
  title,
}: {
  initial: string;
  size?: number;
  fontSize?: number;
  onClick?: () => void;
  forwardRef?: React.Ref<HTMLButtonElement>;
  title?: string;
}) {
  return (
    <button
      ref={forwardRef}
      onClick={onClick}
      title={title}
      style={
        {
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, hsl(var(--story-1)), hsl(var(--story-5)))',
          color: 'hsl(var(--paper))',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-serif)',
          fontStyle: 'italic',
          fontSize,
          fontWeight: 500,
          cursor: onClick ? 'pointer' : 'default',
          border: 'none',
          padding: 0,
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
          transition: 'transform 0.15s ease',
        } as React.CSSProperties
      }
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.transform = 'scale(1.05)';
      }}
      onMouseLeave={(e) => {
        if (onClick) e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {initial}
    </button>
  );
}

function MenuGroup({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        padding: '6px 4px',
        borderBottom: last ? 'none' : '1px solid hsl(var(--rule))',
      }}
    >
      {children}
    </div>
  );
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  tail?: React.ReactNode;
  onClick?: () => void;
}

function MenuItem({ icon, label, meta, tail, onClick }: MenuItemProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 10px',
        fontSize: 12.5,
        color: 'hsl(var(--ink-2))',
        cursor: onClick ? 'pointer' : 'default',
        borderRadius: 3,
        transition: 'background 0.12s ease, color 0.12s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--paper-deep))';
        e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
    >
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
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
    <div
      onClick={onClick}
      title={title}
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
      }}
    >
      {children}
    </div>
  );
}
