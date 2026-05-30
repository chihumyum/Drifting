import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { byokKeychain, maskBYOK, type BYOKProvider } from '../../lib/byok-keychain';
import { getCopilotCapability } from '../../lib/copilot/capability';
import { events } from '../../lib/events';
import { SyncActivityPanel } from '../sync/SyncActivityPanel';
import { useSyncObserver } from '../../services/sync-observer.service';
import { accountService, type DeletionStatus } from '../../services/account.service';
import {
  subscriptionService,
  type Invoice,
  type SubscriptionStatus,
} from '../../services/subscription.service';
import {
  COPILOT_TASKS,
  useSettingsStore,
  type CopilotMode,
  type CopilotTaskId,
  type DateFormat,
  type EditPermission,
  type FinishNotify,
  type AiMode,
  type FocusLineMode,
  type LineHeight,
  type LocaleCode,
  type ModelTier,
  type OrbCorner,
  type ParagraphIndent,
  type ShadowVoice,
  type SurfaceMode,
  type ThemeMode,
} from '../../store/settings-store';
import { useAuthStore } from '../../store/auth';
import { authClient } from '../../lib/auth-client';
import { TrashPanel } from '../TrashPanel';
import { refreshFeatureAccess, useFeatureAccessStore } from '../../lib/feature-access';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator } from '../../lib/shortcuts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Deep-link target. When set, scrolls to this rail on open. */
  initialRailId?: string | null;
}

type RailId =
  | 'account'
  | 'subscription'
  | 'usage'
  | 'trash'
  | 'appearance'
  | 'editor'
  | 'language'
  | 'models'
  | 'shadow'
  | 'copilot'
  | 'keys'
  | 'sync'
  | 'privacy'
  | 'about';

interface RailDef {
  id: RailId;
  group: string;
  glyph: string;
  label: string;
  badge?: { text: string; tone?: 'accent' | 'warn' };
}

// Static rail definition. The subscription row's badge is filled in at
// render time from the actual cached plan — see SetRail.
const RAIL_BASE: Omit<RailDef, 'badge'>[] = [
  { id: 'account', group: '我的账户', glyph: '◌', label: '账号' },
  { id: 'subscription', group: '我的账户', glyph: '¶', label: '订阅' },
  { id: 'usage', group: '我的账户', glyph: '◐', label: 'Shadow 用量' },
  { id: 'trash', group: '我的账户', glyph: '⌫', label: '回收站' },
  { id: 'appearance', group: '偏好', glyph: '☀', label: '外观' },
  { id: 'editor', group: '偏好', glyph: '§', label: '编辑器' },
  { id: 'language', group: '偏好', glyph: '文', label: '语言' },
  { id: 'models', group: '智能', glyph: '✦', label: '模型与 API' },
  { id: 'shadow', group: '智能', glyph: '◐', label: 'Shadow Agent' },
  { id: 'copilot', group: '智能', glyph: '⌁', label: 'Copilot · 任务' },
  { id: 'keys', group: '控制', glyph: '⌨', label: '快捷键' },
  { id: 'sync', group: '控制', glyph: '⇅', label: '同步与数据' },
  { id: 'privacy', group: '关于', glyph: '⚷', label: '隐私' },
  { id: 'about', group: '关于', glyph: '渡', label: '关于 Drifting' },
];

const RAIL_IDS = new Set<RailId>([
  'account',
  'subscription',
  'usage',
  'trash',
  'appearance',
  'editor',
  'language',
  'models',
  'shadow',
  'copilot',
  'keys',
  'sync',
  'privacy',
  'about',
]);

// Compute the rail with dynamic badges — the subscription line shows the
// real cached plan instead of a hardcoded "PRO".
function useRail(): RailDef[] {
  const plan = useFeatureAccessStore((s) => s.plan);
  return useMemo<RailDef[]>(() => {
    return RAIL_BASE.map((r) => {
      if (r.id === 'subscription') {
        return { ...r, badge: { text: plan.toUpperCase() } };
      }
      return r;
    });
  }, [plan]);
}

export function SettingsModal({ isOpen, onClose, initialRailId }: SettingsModalProps) {
  const [active, setActive] = useState<RailId>('account');
  const [query, setQuery] = useState('');
  const mainRef = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Partial<Record<RailId, HTMLElement>>>({});
  const RAIL = useRail();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Scroll-spy: highlight whichever panel's top edge is closest under the
  // header. Mirrors the v2 mockup behavior.
  useEffect(() => {
    if (!isOpen) return;
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => {
      const top = main.scrollTop;
      let current: RailId = RAIL[0].id;
      for (const r of RAIL) {
        const el = panelRefs.current[r.id];
        if (!el) continue;
        if (el.offsetTop - 100 <= top) current = r.id;
      }
      setActive(current);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [isOpen, RAIL]);

  // On open: jump to either the deep-link target or the previously active
  // rail. The component stays mounted while closed, so `active` survives —
  // but `<main>`'s scrollTop resets to 0, which otherwise leaves the rail
  // highlight and content out of sync.
  useEffect(() => {
    if (!isOpen) return;
    const hasDeepLink = !!initialRailId && RAIL_IDS.has(initialRailId as RailId);
    const target = hasDeepLink ? (initialRailId as RailId) : active;
    if (hasDeepLink) setActive(target);
    const apply = () => {
      const el = panelRefs.current[target];
      const main = mainRef.current;
      if (el && main) main.scrollTo({ top: el.offsetTop - 16, behavior: 'auto' });
    };
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
    // `active` intentionally omitted — we only want the value at open time,
    // not a re-scroll on every scroll-spy update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialRailId]);

  const onRail = useCallback((id: RailId) => {
    setActive(id);
    const el = panelRefs.current[id];
    const main = mainRef.current;
    if (el && main) main.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return RAIL;
    return RAIL.filter((r) => r.label.toLowerCase().includes(q) || r.id.includes(q));
  }, [query, RAIL]);

  if (!isOpen) return null;

  return (
    <div className="set-overlay" role="dialog" aria-modal="true">
      <SetHead query={query} setQuery={setQuery} onClose={onClose} />
      {/* Make the whole header draggable on macOS so traffic lights stay
          usable; controls inside set their own no-drag. */}
      <style>{`
        .set-head { -webkit-app-region: drag; }
        .set-head__search, .set-head__close, .set-head__back { -webkit-app-region: no-drag; }
      `}</style>
      <div className="set-body">
        <SetRail items={filtered} active={active} onSelect={onRail} />
        <main className="set-main app-chrome app-island" ref={mainRef}>
          <AccountPanel registerRef={(el) => (panelRefs.current.account = el ?? undefined)} />
          <SubscriptionPanel
            registerRef={(el) => (panelRefs.current.subscription = el ?? undefined)}
          />
          <UsagePanel registerRef={(el) => (panelRefs.current.usage = el ?? undefined)} />
          <TrashRailPanel registerRef={(el) => (panelRefs.current.trash = el ?? undefined)} />
          <AppearancePanel
            registerRef={(el) => (panelRefs.current.appearance = el ?? undefined)}
          />
          <EditorPanel registerRef={(el) => (panelRefs.current.editor = el ?? undefined)} />
          <LanguagePanel registerRef={(el) => (panelRefs.current.language = el ?? undefined)} />
          <ModelsPanel registerRef={(el) => (panelRefs.current.models = el ?? undefined)} />
          <ShadowPanel registerRef={(el) => (panelRefs.current.shadow = el ?? undefined)} />
          <CopilotPanel registerRef={(el) => (panelRefs.current.copilot = el ?? undefined)} />
          <KeysPanel registerRef={(el) => (panelRefs.current.keys = el ?? undefined)} />
          <SyncPanel registerRef={(el) => (panelRefs.current.sync = el ?? undefined)} />
          <PrivacyPanel registerRef={(el) => (panelRefs.current.privacy = el ?? undefined)} />
          <AboutPanel registerRef={(el) => (panelRefs.current.about = el ?? undefined)} />
        </main>
      </div>
    </div>
  );
}

// ─── Head ────────────────────────────────────────────────────────────

function SetHead({
  query,
  setQuery,
  onClose,
}: {
  query: string;
  setQuery: (s: string) => void;
  onClose: () => void;
}) {
  const isMac = navigator.userAgent.includes('Mac');
  return (
    <div
      className="set-head app-chrome app-island"
      style={{ paddingLeft: isMac ? 86 : 18 }}
    >
      <div className="set-head__left">
        <div className="set-head__title">
          设定 <em>Settings · Esc 关闭</em>
        </div>
      </div>

      <div className="set-head__search">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 L14 14" />
        </svg>
        <input
          placeholder="搜索设定…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>⌘F</kbd>
      </div>

      <button className="set-head__close" onClick={onClose} title="关闭 (Esc)">
        ×
      </button>
    </div>
  );
}

// ─── Rail ────────────────────────────────────────────────────────────

function SetRail({
  items,
  active,
  onSelect,
}: {
  items: RailDef[];
  active: RailId;
  onSelect: (id: RailId) => void;
}) {
  const user = useAuthStore((s) => s.user);
  const tier = useSettingsStore((s) => s.modelTier);
  const initial = (user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase();
  const groups: { name: string; items: RailDef[] }[] = [];
  for (const r of items) {
    const g = groups[groups.length - 1];
    if (g && g.name === r.group) g.items.push(r);
    else groups.push({ name: r.group, items: [r] });
  }

  return (
    <nav className="set-rail app-chrome app-island">
      <div className="set-rail__who">
        <div className="set-rail__who-avatar">{initial}</div>
        <div className="set-rail__who-body">
          <div className="set-rail__who-name">{user?.name ?? user?.email ?? '本地用户'}</div>
          <div className="set-rail__who-meta">{tier.toUpperCase()} · 模型档位</div>
        </div>
      </div>

      {groups.map((g) => (
        <div className="set-rail__group" key={g.name}>
          <div className="set-rail__group-title">{g.name}</div>
          {g.items.map((r) => (
            <button
              key={r.id}
              className={
                'set-rail__item' + (active === r.id ? ' set-rail__item--active' : '')
              }
              onClick={() => onSelect(r.id)}
            >
              <span className="set-rail__glyph">{r.glyph}</span>
              <span className="set-rail__label">{r.label}</span>
              {r.badge && (
                <span
                  className={
                    'set-rail__badge' +
                    (r.badge.tone === 'warn' ? ' set-rail__badge--warn' : '')
                  }
                >
                  {r.badge.text}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

// ─── Shared primitives ───────────────────────────────────────────────

function Toggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={'tog' + (on ? ' tog--on' : '')}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={'seg__btn' + (o.value === value ? ' seg__btn--active' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PanelHead({
  kicker,
  title,
  sub,
}: {
  kicker: string;
  title: string;
  sub?: React.ReactNode;
}) {
  return (
    <>
      <div className="set-panel__kicker">{kicker}</div>
      <h1 className="set-panel__title">{title}</h1>
      {sub && <p className="set-panel__sub">{sub}</p>}
    </>
  );
}

function SecHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="set-sec__head">
      <div className="set-sec__title">{title}</div>
      {hint && <div className="set-sec__hint">{hint}</div>}
    </div>
  );
}

function Row({
  label,
  desc,
  control,
  top,
  stack,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  top?: boolean;
  stack?: boolean;
}) {
  return (
    <div className={'set-row' + (top ? ' set-row--top' : '') + (stack ? ' set-row--stack' : '')}>
      <div className="set-row__main">
        <div className="set-row__label">{label}</div>
        {desc && <div className="set-row__desc">{desc}</div>}
      </div>
      {control && <div className="set-row__control">{control}</div>}
    </div>
  );
}

// ─── Panels ──────────────────────────────────────────────────────────

type RegisterRef = (el: HTMLElement | null) => void;

function AccountPanel({ registerRef }: { registerRef: RegisterRef }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // Inline editing state for name + email. Password gets its own modal-y
  // sub-form since it needs current + new + confirm.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);

  // Password change form — only mounted when user clicks "更改"
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Email verification (OTP). Only relevant when user.emailVerified === false.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifySent, setVerifySent] = useState(false);
  const emailVerified = (user as unknown as { emailVerified?: boolean })?.emailVerified ?? false;
  const checkSession = useAuthStore((s) => s.checkSession);

  // Deletion grace period
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);

  // Sessions / devices
  const [sessions, setSessions] = useState<
    Awaited<ReturnType<typeof accountService.listSessions>> | null
  >(null);

  useEffect(() => {
    void accountService.getDeletionStatus().then(setDeletion).catch(() => undefined);
    void accountService.listSessions().then(setSessions).catch(() => undefined);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleSaveName = async () => {
    if (nameDraft === null) return;
    setSavingName(true);
    try {
      await accountService.changeName(nameDraft.trim());
      setNameDraft(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveEmail = async () => {
    if (emailDraft === null) return;
    setSavingEmail(true);
    try {
      await accountService.changeEmail(emailDraft.trim());
      setEmailDraft(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingEmail(false);
    }
  };

  const handleChangePassword = async () => {
    setPwBusy(true);
    setPwError(null);
    try {
      await accountService.changePassword(pwCurrent, pwNew);
      setPwOpen(false);
      setPwCurrent('');
      setPwNew('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwBusy(false);
    }
  };

  const handleSendVerifyOtp = async () => {
    if (!user?.email) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: user.email,
        type: 'email-verification',
      });
      if (res.error) throw new Error(res.error.message || '发送失败');
      setVerifySent(true);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleVerifyEmailOtp = async () => {
    if (!user?.email) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await authClient.emailOtp.verifyEmail({
        email: user.email,
        otp: verifyCode.trim(),
      });
      if (res.error) throw new Error(res.error.message || '验证失败');
      setVerifyOpen(false);
      setVerifyCode('');
      setVerifySent(false);
      await checkSession();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleRequestDeletion = async () => {
    if (!window.confirm('确认请求注销账户？账号将进入 30 天宽限期。')) return;
    setDeletionBusy(true);
    try {
      const status = await accountService.requestDeletion();
      setDeletion(status);
    } finally {
      setDeletionBusy(false);
    }
  };

  const handleCancelDeletion = async () => {
    setDeletionBusy(true);
    try {
      await accountService.cancelDeletion();
      setDeletion({ pending: false });
    } finally {
      setDeletionBusy(false);
    }
  };

  return (
    <section className="set-panel" ref={registerRef} id="account">
      <PanelHead
        kicker="账号 · ACCOUNT"
        title="你的写作身份。"
        sub="这些信息会出现在协作面板、稿件元数据和 Shadow Agent 的署名里——是你给自己作品留下的指印。"
      />

      <div className="set-sec">
        <SecHead title="个人资料" hint="公开 · PUBLIC" />
        <Row
          label="显示名"
          desc="协作者与 Shadow 报告里看见的名字。"
          control={
            nameDraft !== null ? (
              <>
                <input
                  className="set-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  autoFocus
                />
                <button
                  className="set-btn set-btn--primary"
                  onClick={handleSaveName}
                  disabled={savingName}
                >
                  保存
                </button>
                <button className="set-btn" onClick={() => setNameDraft(null)}>
                  取消
                </button>
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value">{user?.name ?? '未设置'}</span>
                <button className="set-field__edit" onClick={() => setNameDraft(user?.name ?? '')}>
                  编辑
                </button>
              </div>
            )
          }
        />
        <Row
          label="邮箱"
          desc="用于登录与账户找回。"
          control={
            emailDraft !== null ? (
              <>
                <input
                  className="set-input set-input--mono"
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  autoFocus
                />
                <button
                  className="set-btn set-btn--primary"
                  onClick={handleSaveEmail}
                  disabled={savingEmail}
                >
                  保存
                </button>
                <button className="set-btn" onClick={() => setEmailDraft(null)}>
                  取消
                </button>
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value set-mono">{user?.email ?? '—'}</span>
                {user?.email && (
                  emailVerified ? (
                    <span className="set-mono" style={{ fontSize: 11, color: 'hsl(var(--accent))' }}>
                      ✓ 已验证
                    </span>
                  ) : (
                    <button
                      className="set-field__edit"
                      onClick={() => {
                        setVerifyOpen((v) => !v);
                        setVerifyError(null);
                      }}
                    >
                      验证
                    </button>
                  )
                )}
                <button className="set-field__edit" onClick={() => setEmailDraft(user?.email ?? '')}>
                  更改
                </button>
              </div>
            )
          }
        />
        {verifyOpen && !emailVerified && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '12px 16px',
              background: 'hsl(var(--paper-deep))',
              borderRadius: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 12,
            }}
          >
            {!verifySent ? (
              <>
                <div style={{ fontSize: 12, color: 'hsl(var(--ink-3))' }}>
                  我们会向 <code>{user?.email}</code> 寄一个 6 位验证码。
                </div>
                {verifyError && (
                  <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{verifyError}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="set-btn set-btn--primary"
                    onClick={handleSendVerifyOtp}
                    disabled={verifyBusy}
                  >
                    寄出
                  </button>
                  <button className="set-btn" onClick={() => setVerifyOpen(false)}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'hsl(var(--ink-3))' }}>
                  已寄到 <code>{user?.email}</code>，10 分钟内输入 6 位验证码。
                </div>
                <input
                  className="set-input set-input--mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位数字"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                {verifyError && (
                  <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{verifyError}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="set-btn set-btn--primary"
                    onClick={handleVerifyEmailOtp}
                    disabled={verifyBusy || verifyCode.length !== 6}
                  >
                    确认
                  </button>
                  <button className="set-btn" onClick={handleSendVerifyOtp} disabled={verifyBusy}>
                    重发
                  </button>
                  <button
                    className="set-btn"
                    onClick={() => { setVerifyOpen(false); setVerifySent(false); setVerifyCode(''); }}
                  >
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <Row
          label="密码"
          desc="更改后其他设备会被强制下线。"
          control={<button className="set-btn" onClick={() => setPwOpen((v) => !v)}>更改</button>}
        />
        {pwOpen && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '12px 16px',
              background: 'hsl(var(--paper-deep))',
              borderRadius: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <input
              className="set-input"
              type="password"
              placeholder="当前密码"
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
            />
            <input
              className="set-input"
              type="password"
              placeholder="新密码（至少 8 位）"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
            />
            {pwError && (
              <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{pwError}</div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="set-btn set-btn--primary"
                onClick={handleChangePassword}
                disabled={pwBusy || pwCurrent.length === 0 || pwNew.length < 8}
              >
                保存密码
              </button>
              <button className="set-btn" onClick={() => setPwOpen(false)}>取消</button>
            </div>
          </div>
        )}

      </div>

      <div className="set-sec">
        <SecHead title="登入设备" hint="ACTIVE SESSIONS" />
        {sessions === null ? (
          <div className="set-row__desc">读取中…</div>
        ) : sessions.length === 0 ? (
          <div className="set-row__desc">仅本机会话。</div>
        ) : (
          sessions.map((s) => (
            <div className="set-device" key={s.id}>
              <div className="set-device__glyph">{s.isCurrent ? '▤' : '▢'}</div>
              <div>
                <div className="set-device__name">
                  <b>{s.userAgent ?? '未知设备'}</b>
                </div>
                <div className="set-device__meta">
                  {s.ipAddress ?? '—'} · {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
              <div className={'set-device__chip' + (s.isCurrent ? '' : ' set-device__chip--idle')}>
                {s.isCurrent ? '本机' : '其他'}
              </div>
              <button
                className="set-btn set-btn--ghost"
                onClick={() =>
                  s.isCurrent
                    ? handleLogout()
                    : accountService
                        .revokeSession(s.id)
                        .then(() => accountService.listSessions().then(setSessions))
                }
              >
                {s.isCurrent ? '登出本机' : '撤销'}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="set-sec">
        <SecHead title="退出登录" hint="SIGN OUT" />
        <Row
          label="登出本机账号"
          desc="结束当前设备会话；本地稿件保留，下次回来重新登录即可。"
          control={
            <button
              className="set-btn set-btn--primary"
              onClick={handleLogout}
            >
              退出登录
            </button>
          }
        />
      </div>

      <div className="set-danger">
        <div className="set-danger__title">危险区</div>
        <Row
          label="导出全部数据"
          desc="下载所有手稿、元素、Shadow 记录与版本历史。"
          control={<button className="set-btn">请求导出</button>}
        />
        {deletion?.pending ? (
          <Row
            label="账户已计划删除"
            desc={`${deletion.daysLeft ?? 30} 天后永久删除（${deletion.scheduledAt ? new Date(deletion.scheduledAt).toLocaleDateString() : ''}）`}
            control={
              <button
                className="set-btn"
                onClick={handleCancelDeletion}
                disabled={deletionBusy}
              >
                取消注销
              </button>
            }
          />
        ) : (
          <Row
            label="删除账户"
            desc="将保留稿件 30 天后永久删除，期间可以恢复。"
            control={
              <button
                className="set-btn set-btn--danger"
                onClick={handleRequestDeletion}
                disabled={deletionBusy}
              >
                删除…
              </button>
            }
          />
        )}
      </div>
    </section>
  );
}

// 订阅 — 仅展示当前计划与「升级 / 降级」「浏览发票」二级页面入口
type SubView = 'overview' | 'plans' | 'invoices';

const PLAN_LABEL: Record<string, string> = {
  free: '渡口（免费）',
  pro: 'Shadow Pro',
  studio: 'Studio',
};

const PLAN_PRICE: Record<string, string> = {
  free: '¥0',
  pro: '¥58',
  studio: '¥168',
};

function SubscriptionPanel({ registerRef }: { registerRef: RegisterRef }) {
  const [view, setView] = useState<SubView>('overview');
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [switching, setSwitching] = useState<'free' | 'pro' | 'studio' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const s = await subscriptionService.getStatus();
      setStatus(s);
      // Keep the global feature-access cache in lockstep so the trash gate
      // (and rail badge) react immediately to a plan change made from this
      // panel.
      await refreshFeatureAccess();
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // DEV plan switch — bypasses Stripe. Removes when payment ships.
  const switchPlan = useCallback(
    async (plan: 'free' | 'pro' | 'studio') => {
      setSwitching(plan);
      try {
        await subscriptionService.setPlan(plan);
        await reload();
      } catch (err) {
        console.error('[set-plan] failed', err);
      } finally {
        setSwitching(null);
      }
    },
    [reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refresh on window focus — covers the "redirected back from Stripe
  // Checkout in the system browser" case.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  useEffect(() => {
    if (view !== 'invoices') return;
    void subscriptionService.listInvoices().then((d) => setInvoices(d.invoices));
  }, [view]);

  const configured = !!status?.stripeConfigured;
  const plan = status?.plan ?? 'free';
  const planName = PLAN_LABEL[plan] ?? plan;
  const renewLine = status?.currentPeriodEnd
    ? `下次扣款 ${new Date(status.currentPeriodEnd).toLocaleDateString()}${
        status.cancelAtPeriodEnd ? ' · 已取消（不会续费）' : ''
      }`
    : '尚未订阅付费方案';

  if (view === 'plans') {
    return (
      <section className="set-panel" ref={registerRef} id="subscription">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setView('overview')}
        >
          <span>←</span>
          <span>返回订阅</span>
        </button>
        <PanelHead kicker="升级 / 降级" title="挑一个更合脚的方案。" />
        {!configured && (
          <div className="set-note" style={{ marginBottom: 16 }}>
            支付通道暂未配置 <b>STRIPE_NOT_CONFIGURED</b>。后台填入 <code>STRIPE_SECRET_KEY</code>{' '}
            后立即可用。
          </div>
        )}
        <div className="set-plans">
          <PlanCard
            kicker="免费"
            name="渡口"
            price="¥0"
            features={[
              '1 个项目 · 50,000 字',
              '基础任务自动化 · 50 次/月',
              '无 Shadow Agent',
              '无 BYOK',
            ]}
            ctaLabel={plan === 'free' ? '当前方案' : switching === 'free' ? '切换中…' : '降级'}
            current={plan === 'free'}
            onClick={plan === 'free' ? undefined : () => switchPlan('free')}
          />
          <PlanCard
            kicker={plan === 'pro' ? '当前 · CURRENT' : '主流推荐'}
            name="Shadow Pro"
            price="¥58"
            features={[
              '无限项目与字数',
              'Shadow Agent · 50 任务/月',
              'Copilot 自动化无限',
              '自带模型 BYOK',
              '版本历史 90 天',
            ]}
            ctaLabel={plan === 'pro' ? '当前方案' : switching === 'pro' ? '切换中…' : '升级'}
            current={plan === 'pro'}
            primary={plan !== 'pro'}
            onClick={plan === 'pro' ? undefined : () => switchPlan('pro')}
          />
          <PlanCard
            kicker={plan === 'studio' ? '当前 · CURRENT' : '专业作家'}
            name="Studio"
            price="¥168"
            features={['Shadow Agent · 不限', '协作者 · 5 席位', '版本历史 1 年', '优先稳定通道']}
            ctaLabel={plan === 'studio' ? '当前方案' : switching === 'studio' ? '切换中…' : '升级'}
            current={plan === 'studio'}
            primary={plan !== 'studio'}
            onClick={plan === 'studio' ? undefined : () => switchPlan('studio')}
          />
        </div>
        <div
          style={{
            marginTop: 18,
            padding: '10px 14px',
            background: 'hsl(var(--paper-deep))',
            border: '1px dashed hsl(var(--rule))',
            borderRadius: 5,
            fontSize: 11,
            color: 'hsl(var(--ink-4))',
            lineHeight: 1.6,
          }}
        >
          <b>DEV</b> · 当前未接入支付。点击直接切换订阅等级，立即生效。Stripe 接通后此面板会改回 Checkout 流程。
        </div>
      </section>
    );
  }

  if (view === 'invoices') {
    return (
      <section className="set-panel" ref={registerRef} id="subscription">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setView('overview')}
        >
          <span>←</span>
          <span>返回订阅</span>
        </button>
        <PanelHead kicker="发票 · INVOICES" title="过往扣款明细。" />
        <div className="set-sec">
          <SecHead title="近期" />
          {!configured && (
            <div className="set-row__desc">支付通道未配置，无法获取发票。</div>
          )}
          {configured && invoices === null && <div className="set-row__desc">读取中…</div>}
          {configured && invoices && invoices.length === 0 && (
            <div className="set-row__desc">暂无发票记录。</div>
          )}
          {configured &&
            invoices?.map((inv) => (
              <Row
                key={inv.id}
                label={
                  <span className="set-italic">
                    {new Date(inv.createdAt).toLocaleDateString()} · {planName}
                  </span>
                }
                desc={
                  <span className="set-mono">
                    {(inv.currency ?? '').toUpperCase()} {(inv.amount / 100).toFixed(2)} ·{' '}
                    {inv.status}
                    {inv.number ? ` · #${inv.number}` : ''}
                  </span>
                }
                control={
                  inv.pdfUrl ? (
                    <button
                      className="set-btn"
                      onClick={() => window.open(inv.pdfUrl ?? '', '_blank')}
                    >
                      下载 PDF
                    </button>
                  ) : null
                }
              />
            ))}
        </div>
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="subscription">
      <PanelHead
        kicker="订阅 · SUBSCRIPTION"
        title="你的方案与发票。"
        sub={
          loading ? (
            '加载中…'
          ) : configured ? (
            <>
              当前方案 <em className="set-italic">{planName.toUpperCase()}</em> · {renewLine}
            </>
          ) : (
            <>
              支付通道暂未配置。填入 <code>STRIPE_SECRET_KEY</code> 后立即可用。中国区可同步评估
              微信 / 支付宝 商户号方案。
            </>
          )
        }
      />

      <div className="set-plan-current">
        <div className="set-plan-current__body">
          <div className="set-plan-current__kicker">
            {plan === 'free' ? '免费' : '当前 · CURRENT'}
          </div>
          <div className="set-plan-current__name">{planName}</div>
          <div className="set-plan-current__meta">
            {PLAN_PRICE[plan] ?? '—'} / 月 · {renewLine}
          </div>
        </div>
        <div className="set-plan-current__cta">
          <button className="set-btn" onClick={() => setView('plans')}>
            升级 / 降级
          </button>
          <button className="set-btn" onClick={() => setView('invoices')}>
            浏览发票
          </button>
        </div>
      </div>

      {configured && plan !== 'free' && (
        <div className="set-sec" style={{ marginTop: 28 }}>
          <SecHead title="付款方式 / 取消" hint="VIA STRIPE PORTAL" />
          <Row
            label="管理付款方式与发票"
            desc="跳转到 Stripe 安全门户。"
            control={
              <button className="set-btn" onClick={() => subscriptionService.openCustomerPortal()}>
                打开门户
              </button>
            }
          />
        </div>
      )}
    </section>
  );
}

function PlanCard({
  kicker,
  name,
  price,
  features,
  ctaLabel,
  current,
  primary,
  onClick,
}: {
  kicker: string;
  name: string;
  price: string;
  features: string[];
  ctaLabel: string;
  current?: boolean;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className={'set-plan' + (current ? ' set-plan--current' : '')}>
      <div className="set-plan__kicker">{kicker}</div>
      <div className="set-plan__name">{name}</div>
      <div className="set-plan__price">
        {price}
        <sub>/月</sub>
      </div>
      <div className="set-plan__rule" />
      {features.map((f) => (
        <div className="set-plan__feat" key={f}>
          {f}
        </div>
      ))}
      <div className="set-plan__cta">
        <button
          className={'set-btn' + (primary ? ' set-btn--primary' : '')}
          onClick={onClick}
          disabled={!onClick}
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}

function TrashRailPanel({ registerRef }: { registerRef: RegisterRef }) {
  return (
    <section className="set-panel" ref={registerRef} id="trash">
      <PanelHead
        kicker="回收站 · TRASH"
        title="软删除的内容。"
        sub="30 天后自动彻底删除。Pro/Studio 专享 — Free 账号删除即永久删除。"
      />
      <TrashPanel />
    </section>
  );
}

function UsagePanel({ registerRef }: { registerRef: RegisterRef }) {
  return (
    <section className="set-panel" ref={registerRef} id="usage">
      <PanelHead
        kicker="Shadow 用量 · USAGE"
        title="这个月，Shadow 为你做了多少事。"
        sub={
          <>
            周期 2026·05·14 → 06·14。配额刷新前你还有 <span className="set-italic">16 次任务</span>。
          </>
        }
      />

      <div
        style={{
          border: '1px solid hsl(var(--rule))',
          borderRadius: 5,
          background: 'hsl(var(--surface))',
          padding: '18px 20px',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: 'hsl(var(--ink-4))',
          }}
        >
          Shadow Agent 任务
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 36,
            color: 'hsl(var(--ink-1))',
            marginTop: 6,
          }}
        >
          34
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'hsl(var(--ink-4))',
              marginLeft: 6,
            }}
          >
            / 50
          </span>
        </div>
        <div
          style={{
            marginTop: 14,
            height: 5,
            background: 'hsl(var(--rule))',
            borderRadius: 3,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div style={{ width: '68%', height: '100%', background: 'hsl(var(--accent))' }} />
        </div>
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 18,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'hsl(var(--ink-4))',
          }}
        >
          <span>
            <b style={{ color: 'hsl(var(--ink-2))' }}>68%</b> 已用
          </span>
          <span>
            剩余 <b style={{ color: 'hsl(var(--ink-2))' }}>16</b> 次
          </span>
          <span>
            日均 <b style={{ color: 'hsl(var(--ink-2))' }}>1.6</b>
          </span>
        </div>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SecHead title="超额行为" hint="GUARDRAILS" />
        <Row
          label="超额时自动暂停"
          desc="达到 100% 时停止接受新任务，不自动按次计费。"
          control={<Toggle on onChange={() => undefined} />}
        />
        <Row
          label="用量预警"
          desc="到达阈值时邮件提醒。"
          control={
            <Seg
              value="80%"
              options={[
                { value: '50%', label: '50%' },
                { value: '70%', label: '70%' },
                { value: '80%', label: '80%' },
                { value: '90%', label: '90%' },
                { value: '关', label: '关' },
              ]}
              onChange={() => undefined}
            />
          }
        />
      </div>
    </section>
  );
}

function AppearancePanel({ registerRef }: { registerRef: RegisterRef }) {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const shadowAffectsTheme = useSettingsStore((s) => s.shadowAffectsTheme);
  const setShadowAffectsTheme = useSettingsStore((s) => s.setShadowAffectsTheme);
  const appearanceSkin = useSettingsStore((s) => s.appearanceSkin);
  const setAppearanceSkin = useSettingsStore((s) => s.setAppearanceSkin);

  const themes: { value: ThemeMode; name: string; kind: string; tp: string }[] = [
    { value: 'light', name: '浅色', kind: 'LIGHT', tp: 'tp--light' },
    { value: 'dark', name: '深色', kind: 'DARK', tp: 'tp--dark' },
    { value: 'system', name: '跟随系统', kind: 'SYSTEM', tp: 'tp--system' },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="appearance">
      <PanelHead
        kicker="外观 · APPEARANCE"
        title="书桌的光线，由你决定。"
        sub="挑一个最合眼的明度，Shadow 模式是否进一步偏冷的色调由你决定。"
      />

      <div className="set-sec">
        <SecHead title="皮肤" hint="SKIN" />
        <Row
          label="界面外观"
          desc="经典手稿，或现代 Craft / Arc 风的浮岛。"
          control={
            <Seg
              value={appearanceSkin}
              options={[
                { value: 'classic', label: '经典' },
                { value: 'modern', label: '现代' },
              ]}
              onChange={setAppearanceSkin}
            />
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title="主题" hint="THEME" />
        <div className="set-theme-grid">
          {themes.map((t) => (
            <button
              key={t.value}
              className={
                'set-theme-card' + (themeMode === t.value ? ' set-theme-card--active' : '')
              }
              onClick={() => setThemeMode(t.value)}
            >
              <div className={'set-theme-card__preview ' + t.tp}>
                <div className="set-theme-card__preview-bar">
                  <span className="set-theme-card__preview-light" />
                  <span className="set-theme-card__preview-light" />
                  <span className="set-theme-card__preview-light" />
                </div>
                <div className="set-theme-card__preview-body">
                  <div className="set-theme-card__preview-rail" />
                  <div className="set-theme-card__preview-lines">
                    <div className="set-theme-card__preview-line" />
                    <div className="set-theme-card__preview-line" />
                    <div className="set-theme-card__preview-line" />
                  </div>
                  <div className="set-theme-card__preview-aux" />
                </div>
              </div>
              <div className="set-theme-card__meta">
                <span className="set-theme-card__name">{t.name}</span>
                <span className="set-theme-card__kind">{t.kind}</span>
              </div>
              <div className="set-theme-card__check">✓</div>
            </button>
          ))}
        </div>

        <Row
          label="Shadow 模式改变主题色调"
          desc="开启时，进入 Shadow 模式会同时把纸面调向冷色与梅紫；关闭则只切换右栏面板。"
          control={<Toggle on={shadowAffectsTheme} onChange={setShadowAffectsTheme} />}
        />
      </div>
    </section>
  );
}

function EditorPanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    bodyFontSize,
    setBodyFontSize,
    lineHeight,
    setLineHeight,
    paragraphIndent,
    setParagraphIndent,
    maxLineWidth,
    setMaxLineWidth,
    focusLine,
    setFocusLine,
    entityHighlight,
    setEntityHighlight,
    autosave,
    setAutosave,
    autoElementLinkEnabled,
    setAutoElementLinkEnabled,
  } = useSettingsStore();

  return (
    <section className="set-panel" ref={registerRef} id="editor">
      <PanelHead
        kicker="编辑器 · EDITOR"
        title="字落在纸上的样子。"
        sub="写作区的字体、行距、聚焦行为，与稿件本身的导出无关。"
      />

      <div className="set-sec">
        <SecHead title="排版" hint="TYPESETTING" />
        <Row
          label="字号"
          desc="编辑视图字号；导出稿件不受影响。"
          control={
            <div className="set-slider">
              <input
                type="range"
                min={12}
                max={28}
                value={bodyFontSize}
                onChange={(e) => setBodyFontSize(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{bodyFontSize} px</span>
            </div>
          }
        />
        <Row
          label="行距"
          control={
            <Seg<string>
              value={String(lineHeight)}
              options={['1.5', '1.65', '1.72', '1.8', '2.0'].map((v) => ({ value: v, label: v }))}
              onChange={(v) => setLineHeight(Number(v) as LineHeight)}
            />
          }
        />
        <Row
          label="段首缩进"
          desc="仅编辑视图。导出时按稿件格式独立设定。"
          control={
            <Seg<ParagraphIndent>
              value={paragraphIndent}
              options={[
                { value: 'none', label: '无' },
                { value: 'one', label: '一字符' },
                { value: 'two', label: '两字符' },
              ]}
              onChange={setParagraphIndent}
            />
          }
        />
        <Row
          label="最大行宽"
          desc="单页中央栏的最大宽度。"
          control={
            <input
              className="set-input set-input--mono"
              style={{ minWidth: 120 }}
              value={`${maxLineWidth} px`}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                if (Number.isFinite(n)) setMaxLineWidth(n);
              }}
            />
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title="书写体验" hint="FLOW" />
        <Row
          label="聚焦行"
          desc="把当前段落以外的内容轻度淡出。"
          control={
            <Seg<FocusLineMode>
              value={focusLine}
              options={[
                { value: 'off', label: '关' },
                { value: 'paragraph', label: '段落' },
                { value: 'line', label: '行' },
                { value: 'sentence', label: '句' },
              ]}
              onChange={setFocusLine}
            />
          }
        />
        <Row
          label="实体高亮"
          desc="在正文中给已识别的人物 / 地点 / 物件添加下划虚线。"
          control={<Toggle on={entityHighlight} onChange={setEntityHighlight} />}
        />
        <Row
          label="自动元素链接"
          desc="输入时自动识别已存在的元素名称（如人物、地点），并链接到对应页面。"
          control={<Toggle on={autoElementLinkEnabled} onChange={setAutoElementLinkEnabled} />}
        />
        <Row
          label="自动保存"
          desc={
            <>
              每次空闲超过 <code>3 秒</code>。
            </>
          }
          control={<Toggle on={autosave} onChange={setAutosave} />}
        />
      </div>
    </section>
  );
}

function LanguagePanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    uiLocale,
    setUiLocale,
    manuscriptLocale,
    setManuscriptLocale,
    spellcheck,
    setSpellcheck,
    dateFormat,
    setDateFormat,
  } = useSettingsStore();

  const locales: { code: LocaleCode; name: string; native: string }[] = [
    { code: 'zh-CN', name: '中文（简体）', native: '默认' },
    { code: 'zh-TW', name: '中文（繁體）', native: '繁體' },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'ja', name: '日本語', native: '日本語' },
    { code: 'ko', name: '한국어', native: '한국어' },
    { code: 'fr', name: 'Français', native: 'beta' },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="language">
      <PanelHead
        kicker="语言 · LANGUAGE"
        title="界面用什么语言对你说话。"
        sub="这只关乎界面文本——稿件与 Shadow 的回复语言独立设置在下方。"
      />

      <div className="set-sec">
        <SecHead title="界面语言" hint="UI LOCALE" />
        <div className="set-locales">
          {locales.map((l) => (
            <button
              key={l.code}
              className={'set-locale' + (uiLocale === l.code ? ' set-locale--active' : '')}
              onClick={() => setUiLocale(l.code)}
            >
              <span className="set-locale__code">{l.code}</span>
              <span className="set-locale__name">{l.name}</span>
              <span className="set-locale__native">{l.native}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <SecHead title="写作语言" hint="MANUSCRIPT" />
        <Row
          label="手稿默认语言"
          desc="影响拼写检查、断行、Shadow Agent 的回复语言。"
          control={
            <select
              className="set-input"
              style={{ minWidth: 220 }}
              value={manuscriptLocale}
              onChange={(e) => setManuscriptLocale(e.target.value as LocaleCode)}
            >
              {locales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} · {l.code}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="拼写检查"
          desc="中文按词典检查别字。英文使用系统拼写。"
          control={<Toggle on={spellcheck} onChange={setSpellcheck} />}
        />
        <Row
          label="日期与数字"
          desc="影响时间线轴标签。"
          control={
            <Seg<DateFormat>
              value={dateFormat}
              options={[
                { value: 'cjk', label: '中文' },
                { value: 'iso', label: 'ISO' },
                { value: 'us', label: 'US' },
              ]}
              onChange={setDateFormat}
            />
          }
        />
      </div>
    </section>
  );
}

function ModelsPanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    modelTier,
    setModelTier,
    aiMode,
    setAiMode,
    ollamaEndpoint,
    setOllamaEndpoint,
    uploadFullManuscript,
    setUploadFullManuscript,
    allowWebSearch,
    setAllowWebSearch,
    requestTimeoutSec,
    setRequestTimeoutSec,
  } = useSettingsStore();

  const tiers: { value: ModelTier; kicker: string; name: string; desc: string }[] = [
    { value: 'lite', kicker: 'LITE', name: '轻量', desc: '速度优先。短建议、实体抽取等高吞吐任务。' },
    { value: 'standard', kicker: 'STANDARD', name: '标准', desc: '日常默认。结构、连贯、润色都够用。' },
    { value: 'pro', kicker: 'PRO', name: '深思', desc: '长上下文、长任务推理。慢一点，更稳。' },
  ];

  const aiModes: { value: AiMode; kicker: string; name: string; desc: string }[] = [
    {
      value: 'hosted',
      kicker: 'HOSTED',
      name: '托管',
      desc: '走 Drifting 的通道与额度，开箱即用。Prompt 与密钥都在服务端。',
    },
    {
      value: 'byok',
      kicker: 'BYOK',
      name: '自带 Key',
      desc: '用你自己的 Key 调用（在下方「自带密钥」填入 DeepSeek Key），不计入托管额度。',
    },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="models">
      <PanelHead
        kicker="模型与 API · MODELS"
        title="让谁来读你的草稿。"
        sub={
          <>
            Drifting 把任务分成几个能力档位。默认走我们维护的通道，也可以接入你自己的 API。
            <span className="set-italic"> 你的密钥仅存于本机 Keychain，不上传服务器。</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title="能力档位" hint="DEFAULT TIER" />
        <div className="set-tiers">
          {tiers.map((t) => (
            <button
              key={t.value}
              className={'set-tier' + (modelTier === t.value ? ' set-tier--active' : '')}
              onClick={() => setModelTier(t.value)}
            >
              <div className="set-tier__kicker">{t.kicker}</div>
              <div className="set-tier__name">{t.name}</div>
              <div className="set-tier__desc">{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <SecHead title="AI 调用方式" hint="ROUTING" />
        <div className="set-tiers">
          {aiModes.map((m) => (
            <button
              key={m.value}
              className={'set-tier' + (aiMode === m.value ? ' set-tier--active' : '')}
              onClick={() => setAiMode(m.value)}
            >
              <div className="set-tier__kicker">{m.kicker}</div>
              <div className="set-tier__name">{m.name}</div>
              <div className="set-tier__desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <SecHead title="自带密钥 · BYOK" hint="4 PROVIDERS" />

        <ProviderRow
          provider="deepseek"
          logoClass="set-provider__logo--deepseek"
          logoText="D"
          name="DeepSeek"
          desc="选「自带 Key」后实际调用的 provider。在此填入你的 DeepSeek Key。"
        />

        <ProviderRow
          provider="anthropic"
          logoClass="set-provider__logo--anthropic"
          logoText="A"
          name="Anthropic"
          desc="Claude Opus / Sonnet / Haiku。Drifting 通过你的密钥按你的额度计费。"
        />

        <ProviderRow
          provider="openai"
          logoClass="set-provider__logo--openai"
          logoText="O"
          name="OpenAI"
          desc="GPT 系列模型。"
        />

        <ProviderRow
          provider="google"
          logoClass="set-provider__logo--google"
          logoText="G"
          name="Google"
          desc="Gemini 2.5 Pro / Flash · 长上下文场景。"
        />
      </div>

      <div className="set-sec">
        <SecHead title="本地模型" hint="LOCAL" />
        <div className="set-provider">
          <div className="set-provider__head">
            <div className="set-provider__logo set-provider__logo--ollama">◖</div>
            <div className="set-provider__main">
              <div className="set-provider__name">
                <b>Ollama</b> <em>本地</em>
              </div>
              <div className="set-provider__desc">
                本机模型，零数据外发。配置端点后，Copilot 与 Shadow Agent 都可以走本地。
              </div>
            </div>
          </div>
          <div className="set-provider__body">
            <div className="set-provider__body-inner">
              <span className="set-provider__k">Endpoint</span>
              <span className="set-provider__v">
                <input
                  className="set-input set-input--mono"
                  style={{ minWidth: 280 }}
                  value={ollamaEndpoint}
                  onChange={(e) => setOllamaEndpoint(e.target.value)}
                />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="set-sec">
        <SecHead title="高级" hint="ADVANCED" />
        <Row
          label="允许稿件全文上传"
          desc="关闭时，只发送相关段落与摘要——更慢但更稳妥。"
          control={<Toggle on={uploadFullManuscript} onChange={setUploadFullManuscript} />}
        />
        <Row
          label="允许模型联网"
          desc="仅对支持 web 工具的模型生效。"
          control={<Toggle on={allowWebSearch} onChange={setAllowWebSearch} />}
        />
        <Row
          label="请求超时"
          desc="单次 LLM 调用最长等待时间。"
          control={
            <input
              className="set-input set-input--mono"
              style={{ minWidth: 90 }}
              value={`${requestTimeoutSec} s`}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                if (Number.isFinite(n)) setRequestTimeoutSec(n);
              }}
            />
          }
        />
      </div>
    </section>
  );
}

function ProviderRow({
  provider,
  logoClass,
  logoText,
  name,
  desc,
}: {
  provider: BYOKProvider;
  logoClass: string;
  logoText: string;
  name: string;
  desc: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [stored, setStored] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from the OS keychain on mount. The renderer never holds the
  // secret in any persisted store — only this local state for masking.
  useEffect(() => {
    let cancelled = false;
    byokKeychain.get(provider).then((value) => {
      if (cancelled) return;
      setStored(value);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const connected = !!stored;
  const masked = useMemo(() => maskBYOK(stored), [stored]);

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      await byokKeychain.clear(provider);
      setStored(null);
    } else {
      await byokKeychain.set(provider, value);
      setStored(value);
    }
    setDraft('');
    setEditing(false);
  };

  const disconnect = async () => {
    await byokKeychain.clear(provider);
    setStored(null);
  };

  return (
    <div className={'set-provider' + (connected ? ' set-provider--connected' : ' set-provider--disconnected')}>
      <div className="set-provider__head">
        <div className={`set-provider__logo ${logoClass}`}>{logoText}</div>
        <div className="set-provider__main">
          <div className="set-provider__name">
            <b>{name}</b>
            <em className={connected ? 'is-byok' : ''}>{connected ? '自带密钥' : '未连接'}</em>
          </div>
          <div className="set-provider__desc">{desc}</div>
        </div>
        <div className={'set-provider__status ' + (connected ? 'set-provider__status--live' : 'set-provider__status--off')}>
          <span className="set-provider__status-dot" />
          {connected ? 'CONNECTED' : 'OFFLINE'}
        </div>
      </div>

      {(connected || editing) && (
        <div className="set-provider__body">
          <div className="set-provider__body-inner">
            <span className="set-provider__k">API Key</span>
            <span className="set-provider__v">
              {editing ? (
                <input
                  className="set-input set-input--mono"
                  style={{ minWidth: 320 }}
                  placeholder="粘贴密钥..."
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
              ) : (
                <code>{masked}</code>
              )}
              {!editing && (
                <span className="set-mono" style={{ color: 'hsl(var(--ink-4))' }}>
                  · KEYCHAIN
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="set-provider__actions">
        {loading ? null : editing ? (
          <>
            <button className="set-btn set-btn--primary" onClick={save}>
              保存
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              取消
            </button>
          </>
        ) : connected ? (
          <>
            <button className="set-btn">测试连接</button>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              编辑密钥
            </button>
            <span style={{ flex: 1 }} />
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              断开
            </button>
          </>
        ) : (
          <button
            className="set-btn set-btn--primary"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
          >
            连接
          </button>
        )}
      </div>
    </div>
  );
}

function ShadowPanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    orbCorner,
    setOrbCorner,
    surfaceMode,
    setSurfaceMode,
    finishNotify,
    setFinishNotify,
    editPermission,
    setEditPermission,
    agentCreateElements,
    setAgentCreateElements,
    agentEditTimeline,
    setAgentEditTimeline,
    agentWebSearch,
    setAgentWebSearch,
    shadowVoice,
    setShadowVoice,
    shadowSystemPrompt,
    setShadowSystemPrompt,
  } = useSettingsStore();

  return (
    <section className="set-panel" ref={registerRef} id="shadow">
      <PanelHead
        kicker="SHADOW AGENT · 影"
        title="影怎么进出你的稿子。"
        sub="Shadow 在背景里读你的稿子，它何时浮现、能动什么——都在这里决定。"
      />

      <div className="set-sec">
        <SecHead title="触发与浮现" hint="INVOCATION" />
        <Row
          label="墨珠位置"
          desc="墨珠停靠的屏幕角落。"
          control={
            <Seg<OrbCorner>
              value={orbCorner}
              options={[
                { value: 'bl', label: '左下' },
                { value: 'tl', label: '左上' },
                { value: 'tr', label: '右上' },
                { value: 'br', label: '右下' },
              ]}
              onChange={setOrbCorner}
            />
          }
        />
        <Row
          label="主动浮现"
          desc="Shadow 发现重要建议时短暂闪现。"
          control={
            <Seg<SurfaceMode>
              value={surfaceMode}
              options={[
                { value: 'never', label: '从不' },
                { value: 'keyMoments', label: '关键时刻' },
                { value: 'all', label: '所有更新' },
              ]}
              onChange={setSurfaceMode}
            />
          }
        />
        <Row
          label="完成时通知"
          desc="长任务完成时的提示形式。"
          control={
            <Seg<FinishNotify>
              value={finishNotify}
              options={[
                { value: 'silent', label: '无声' },
                { value: 'stack', label: '堆叠' },
                { value: 'system', label: '系统通知' },
              ]}
              onChange={setFinishNotify}
            />
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title="能动什么" hint="PERMISSIONS" />
        <Row
          label="直接编辑稿件"
          desc="关闭时，Shadow 只能写建议、不能改字。"
          control={
            <Seg<EditPermission>
              value={editPermission}
              options={[
                { value: 'suggest', label: '仅建议' },
                { value: 'small', label: '小改' },
                { value: 'all', label: '允许全改' },
              ]}
              onChange={setEditPermission}
            />
          }
        />
        <Row
          label="创建新元素"
          desc="提到新名字时自动建档。"
          control={<Toggle on={agentCreateElements} onChange={setAgentCreateElements} />}
        />
        <Row
          label="修改时间线"
          desc="Shadow 可在时间线上调整章节锚点位置。"
          control={<Toggle on={agentEditTimeline} onChange={setAgentEditTimeline} />}
        />
        <Row
          label="联网检索"
          desc="用于历史 / 地理 / 风物考据。"
          control={<Toggle on={agentWebSearch} onChange={setAgentWebSearch} />}
        />
      </div>

      <div className="set-sec">
        <SecHead title="语气" hint="VOICE" />
        <Row
          label="编辑语气"
          desc="Shadow 给批注的语气强度。"
          control={
            <Seg<ShadowVoice>
              value={shadowVoice}
              options={[
                { value: 'restrained', label: '克制' },
                { value: 'direct', label: '直率' },
                { value: 'sharp', label: '尖锐' },
              ]}
              onChange={setShadowVoice}
            />
          }
        />
        <Row
          stack
          label={
            <>
              系统提示 <em>SYSTEM PROMPT</em>
            </>
          }
          desc="追加在每次任务前的指令，定义 Shadow 看你稿子的角度。"
          control={
            <textarea
              className="set-input set-input--mono"
              rows={4}
              value={shadowSystemPrompt}
              onChange={(e) => setShadowSystemPrompt(e.target.value)}
              style={{ minWidth: '100%', lineHeight: 1.55, fontFamily: 'var(--font-mono)' }}
            />
          }
        />
      </div>
    </section>
  );
}

const COPILOT_DEBOUNCE_MIN_SEC = 1;
const COPILOT_DEBOUNCE_MAX_SEC = 60;
const COPILOT_SECTION_SIZE_MIN = 3;
const COPILOT_SECTION_SIZE_MAX = 30;

function clampDebounceSec(sec: number): number {
  return Math.min(
    COPILOT_DEBOUNCE_MAX_SEC,
    Math.max(COPILOT_DEBOUNCE_MIN_SEC, Math.round(sec)),
  );
}

/**
 * Per-task config row. Shows the task's name, a wired/not-wired indicator,
 * its enable toggle, and (if wired) a debounce slider. The slider value
 * defaults to the capability's `defaultDebounceMs` until the user overrides.
 */
function CopilotTaskRow({ taskId, label, desc }: { taskId: CopilotTaskId; label: string; desc: string }) {
  const cfg = useSettingsStore((s) => s.copilotTaskConfigs[taskId]);
  const setEnabled = useSettingsStore((s) => s.setCopilotTaskEnabled);
  const setDebounceMs = useSettingsStore((s) => s.setCopilotTaskDebounceMs);

  const cap = getCopilotCapability(taskId);
  const wired = Boolean(cap);
  const enabled = cfg?.enabled ?? false;
  const effectiveMs = cfg?.debounceMs ?? cap?.defaultDebounceMs ?? 5000;
  const effectiveSec = Math.round(effectiveMs / 1000);
  const isOverride = cfg?.debounceMs !== undefined;

  return (
    <div
      style={{
        padding: '14px 0',
        borderTop: '1px solid hsl(var(--rule) / 0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{label}</strong>
            {!wired && (
              <span style={{ fontSize: 11, color: 'hsl(var(--ink-3))', padding: '1px 6px', borderRadius: 4, background: 'hsl(var(--rule) / 0.3)' }}>
                未上线
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--ink-2))', marginTop: 4 }}>{desc}</div>
        </div>
        <Toggle
          on={enabled}
          onChange={(on) => setEnabled(taskId, on)}
        />
      </div>

      {wired && enabled && (
        <div style={{ marginTop: 12, paddingLeft: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 12, color: 'hsl(var(--ink-3))', marginBottom: 4 }}>
            <span>触发节奏</span>
            <span>
              停笔
              <span style={{ fontFamily: 'var(--font-mono)', margin: '0 4px', color: 'hsl(var(--ink-1))' }}>
                {effectiveSec}s
              </span>
              后触发
              {isOverride && (
                <button
                  onClick={() => setDebounceMs(taskId, undefined)}
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    color: 'hsl(var(--accent))',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  title="恢复该 task 的内置默认值"
                >
                  重置默认
                </button>
              )}
            </span>
          </div>
          <input
            type="range"
            min={COPILOT_DEBOUNCE_MIN_SEC}
            max={COPILOT_DEBOUNCE_MAX_SEC}
            step={1}
            value={effectiveSec}
            onChange={(e) =>
              setDebounceMs(taskId, clampDebounceSec(parseInt(e.target.value, 10)) * 1000)
            }
            style={{ width: '100%', accentColor: 'hsl(var(--accent))' }}
          />
        </div>
      )}
    </div>
  );
}

function CopilotPanel({ registerRef }: { registerRef: RegisterRef }) {
  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const setAutoTrigger = useSettingsStore((s) => s.setCopilotAutoTrigger);
  const copilotInDrift = useSettingsStore((s) => s.copilotInDrift);
  const setCopilotInDrift = useSettingsStore((s) => s.setCopilotInDrift);
  const copilotMode = useSettingsStore((s) => s.copilotMode);
  const setCopilotMode = useSettingsStore((s) => s.setCopilotMode);
  const generateSummaries = useSettingsStore((s) => s.copilotGenerateSummaries);
  const setGenerateSummaries = useSettingsStore((s) => s.setCopilotGenerateSummaries);
  const sectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const setSectionSize = useSettingsStore((s) => s.setCopilotSummarySectionSize);

  return (
    <section className="set-panel" ref={registerRef} id="copilot">
      <PanelHead
        kicker="COPILOT · 任务"
        title="把琐事交给一个安静的副手。"
        sub="每个任务独立配置——什么时候触发、要不要开。它不会替你写正文。"
      />

      <div className="set-sec">
        <SecHead title="开关" hint="ENABLE" />
        <Row
          label="自动触发"
          desc="编辑时按 debounce 自动后台运行 task。关闭后只在你手动触发（⇧⌘I / 右键）时运行。"
          control={<Toggle on={autoTrigger} onChange={setAutoTrigger} />}
        />
        <Row
          label="在 drift 节点中启用"
          desc="drift 是灵感草稿区，默认不打扰。关闭时 Copilot 只在章节编辑器里工作；开启后 drift 编辑器也会跑同样的 task。"
          control={<Toggle on={copilotInDrift} onChange={setCopilotInDrift} />}
        />
      </div>

      <div className="set-sec">
        <SecHead title="模型来源" hint="ROUTING" />
        <Row
          label="运行位置"
          desc={
            copilotMode === 'local'
              ? '走本地 Ollama 端点。零数据外发，速度取决于硬件。'
              : '走云端模型 —— 官方通道或你的 BYOK 密钥（取决于「模型与 API」配置）。'
          }
          control={
            <Seg<CopilotMode>
              value={copilotMode}
              options={[
                { value: 'local', label: '本地' },
                { value: 'cloud', label: '云端' },
              ]}
              onChange={setCopilotMode}
            />
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title="段落概要" hint="SUMMARY" />
        <Row
          label="生成段落概要"
          desc="任何 task 触发后，若未被概要的 block 累积到阈值，会发一次概要调用。概要会作为后续 task 的上下文，提升 patch 召回；关闭则不生成、不注入。"
          control={<Toggle on={generateSummaries} onChange={setGenerateSummaries} />}
        />
        {generateSummaries && (
          <Row
            label="概要阈值"
            desc={`攒够 ${sectionSize} 个未概要的 block 后再生成一段。值越大越省 token；值越小概要越频繁。`}
            stack
            control={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minWidth: 220 }}>
                <input
                  type="range"
                  min={COPILOT_SECTION_SIZE_MIN}
                  max={COPILOT_SECTION_SIZE_MAX}
                  step={1}
                  value={sectionSize}
                  onChange={(e) => setSectionSize(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: 'hsl(var(--accent))' }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    minWidth: 32,
                    textAlign: 'right',
                    color: 'hsl(var(--ink-2))',
                  }}
                >
                  {sectionSize} 块
                </span>
              </div>
            }
          />
        )}
      </div>

      <div className="set-sec">
        <SecHead title="任务" hint="TASKS" />
        <p className="set-row__desc" style={{ margin: '-4px 0 0' }}>
          每个 task 都能独立开关和调触发节奏。低 debounce 适合轻量识别（如实体抽取），高 debounce 适合重型分析（如 patch 提议）。
        </p>
        {COPILOT_TASKS.map((t) => (
          <CopilotTaskRow key={t.id} taskId={t.id} label={t.label} desc={t.desc} />
        ))}
      </div>
    </section>
  );
}

function KeysPanel({ registerRef }: { registerRef: RegisterRef }) {
  const bindings = useShortcutsStore((s) => s.bindings);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setError(null);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      const conflict = (Object.entries(bindings) as [ShortcutActionId, string][]).find(
        ([id, accel]) => id !== recording && accel === accelerator,
      );
      if (conflict) {
        const def = SHORTCUT_ACTIONS.find((a) => a.id === conflict[0]);
        setError(`${formatAccelerator(accelerator)} 已被「${def?.label ?? conflict[0]}」占用`);
        return;
      }
      setBinding(recording, accelerator);
      setRecording(null);
      setError(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, bindings, setBinding]);

  return (
    <section className="set-panel" ref={registerRef} id="keys">
      <PanelHead
        kicker="键盘 · KEYBOARD"
        title="手不离键盘的写作。"
        sub="点击任意快捷键即可重新绑定。按 Esc 取消录制。"
      />

      {error && (
        <div className="set-note" style={{ marginBottom: 14, color: 'hsl(var(--accent))' }}>
          {error}
        </div>
      )}

      <div className="set-keys">
        <div className="set-keys__group-head">所有动作 · {SHORTCUT_ACTIONS.length} ACTIONS</div>
        {SHORTCUT_ACTIONS.map((action) => {
          const accel = bindings[action.id];
          const isRecording = recording === action.id;
          return (
            <div className="set-keys__row" key={action.id}>
              <div>
                <div className="set-keys__label">{action.label}</div>
                <div className="set-row__desc" style={{ marginTop: 2 }}>
                  {action.description}
                </div>
              </div>
              <span className="set-keys__cat">{isRecording ? '录制中' : ''}</span>
              <button
                className="set-keys__combo"
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : action.id);
                }}
                onDoubleClick={() => resetBinding(action.id)}
                style={{ background: 'transparent', border: 0, padding: 0 }}
                title="双击恢复默认"
              >
                {(isRecording ? '按下新组合键…' : formatAccelerator(accel)).split('+').map((part, i, arr) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <span className="kbd">{part}</span>
                    {i < arr.length - 1 && <span className="kbd kbd--plus">+</span>}
                  </span>
                ))}
              </button>
            </div>
          );
        })}
      </div>

      <Row
        label="恢复全部默认"
        desc="重置所有快捷键。"
        control={<button className="set-btn" onClick={resetAll}>恢复</button>}
      />
    </section>
  );
}

function SyncSummaryRow() {
  // Live metrics from the sync observer. We don't import the full
  // SyncActivityPanel here — that keeps the overview row light.
  const metrics = useSyncObserver((s) => s.metrics);
  const last = metrics.lastSuccessAt
    ? new Date(metrics.lastSuccessAt).toLocaleTimeString()
    : '—';
  const successPct = Math.round(metrics.successRate * 100);
  return (
    <Row
      label="Drifting 云"
      desc={
        <>
          上次成功 <span className="set-italic">{last}</span> · 成功率{' '}
          <b>{successPct}%</b>
          {metrics.inflight > 0 ? ` · 进行中 ${metrics.inflight}` : ''}
        </>
      }
      control={
        <>
          <span
            className="set-mono"
            style={{ color: metrics.failed > 0 ? 'hsl(var(--accent))' : 'hsl(var(--accent))' }}
          >
            {metrics.inflight > 0 ? '同步中' : '在线'}
          </span>
          <button className="set-btn">立即同步</button>
        </>
      }
    />
  );
}

function SyncPanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    wifiOnlySync,
    setWifiOnlySync,
    autoSnapshot,
    setAutoSnapshot,
    syncDebugToasts,
    setSyncDebugToasts,
  } = useSettingsStore();
  const [activityOpen, setActivityOpen] = useState(false);

  if (activityOpen) {
    return (
      <section className="set-panel" ref={registerRef} id="sync">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setActivityOpen(false)}
        >
          <span>←</span>
          <span>返回同步</span>
        </button>
        <PanelHead
          kicker="同步活动 · ACTIVITY"
          title="刚才同步了什么。"
          sub="最近 200 条同步事件。失败原因会展开在每行尾部。"
        />
        <SyncActivityPanel />
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="sync">
      <PanelHead
        kicker="同步 · SYNC"
        title="稿子放哪儿，又备份在哪儿。"
        sub="Drifting 默认端到端加密同步。本地仓库与云端互为副本。"
      />

      <div className="set-sec">
        <SecHead title="云同步" hint="E2E ENCRYPTED" />
        <SyncSummaryRow />
        <Row
          label="同步活动"
          desc="最近 200 条 push / pull 事件，含失败原因。"
          control={
            <button className="set-btn" onClick={() => setActivityOpen(true)}>
              查看完整记录
            </button>
          }
        />
        <Row
          label="仅 Wi-Fi 同步"
          desc="在 iPad / iPhone 上避免移动流量。"
          control={<Toggle on={wifiOnlySync} onChange={setWifiOnlySync} />}
        />
        <Row
          label="本地仓库"
          desc={<span className="set-mono">~/Library/Drifting/vault</span>}
          control={<button className="set-btn">在 Finder 中显示</button>}
        />
        <Row
          label="调试模式 · Toast"
          desc="开启后，主页右下角会浮出 push / pull 事件的小提示，用于排查同步问题。"
          control={<Toggle on={syncDebugToasts} onChange={setSyncDebugToasts} />}
        />
      </div>

      <div className="set-sec">
        <SecHead title="版本历史" hint="SNAPSHOTS" />
        <Row
          label="自动快照"
          desc={<>每章节每 <code>5 分钟</code> 一份；保留 90 天。</>}
          control={<Toggle on={autoSnapshot} onChange={setAutoSnapshot} />}
        />
        <Row
          label="手动里程碑"
          desc="标记重大稿——永久保留，不计入 90 天。"
          control={<button className="set-btn">查看</button>}
        />
      </div>

      <div className="set-sec">
        <SecHead title="导入" hint="IMPORT" />
        <Row
          label="导入"
          desc="从 Markdown / Word / 纯文本 导入为章节、元素或浮缀。"
          control={
            <button
              className="set-btn"
              onClick={() => {
                events.emit('import:open');
              }}
            >
              选择文件…
            </button>
          }
        />
      </div>
    </section>
  );
}

function PrivacyPanel({ registerRef }: { registerRef: RegisterRef }) {
  const {
    improveModelsWithManuscripts,
    setImproveModelsWithManuscripts,
    sendUsageStats,
    setSendUsageStats,
    sendCrashLogs,
    setSendCrashLogs,
  } = useSettingsStore();

  return (
    <section className="set-panel" ref={registerRef} id="privacy">
      <PanelHead
        kicker="隐私 · PRIVACY"
        title="你的稿子，停在哪儿。"
        sub="这页直说：Drifting 用了什么、不用什么、何时离开你的机器。"
      />

      <div className="set-note">
        稿件以端到端加密同步，密钥仅在你机器上生成。Drifting 服务器看不到稿件原文。
        <br />
        <span className="set-mono" style={{ display: 'inline-block', marginTop: 6 }}>
          默认情况下你的稿件 <b>不会</b> 被用于训练任何模型。
        </span>
      </div>

      <div className="set-sec" style={{ marginTop: 18 }}>
        <SecHead title="数据使用" hint="YOUR CONTROL" />
        <Row
          label="允许使用稿件改进官方模型"
          desc="仅你明确开启时。被采样的段落会先去标识化处理。"
          control={
            <Toggle on={improveModelsWithManuscripts} onChange={setImproveModelsWithManuscripts} />
          }
        />
        <Row
          label="发送匿名使用统计"
          desc="界面点击、错误、性能指标。不含稿件内容。"
          control={<Toggle on={sendUsageStats} onChange={setSendUsageStats} />}
        />
        <Row
          label="崩溃日志"
          desc="应用崩溃时上传堆栈与运行环境。"
          control={<Toggle on={sendCrashLogs} onChange={setSendCrashLogs} />}
        />
      </div>

      <Row
        label="查看完整隐私政策"
        desc={<span className="set-mono">最近更新 2026·04·02</span>}
        control={<button className="set-btn">在浏览器打开</button>}
      />
    </section>
  );
}

function AboutPanel({ registerRef }: { registerRef: RegisterRef }) {
  return (
    <section className="set-panel" ref={registerRef} id="about">
      <PanelHead kicker="关于 · ABOUT" title="Drifting · 渡舟" sub="一只为长篇小说准备的写作船。" />

      <div className="set-about">
        <div className="set-about__glyph">渡</div>
        <div className="set-about__main">
          <div className="set-about__name">
            Drifting <em>渡舟</em>
          </div>
          <div className="set-about__meta">
            <span>
              版本 <b>0.1.0</b>
            </span>
            <span>
              通道 <b>开发</b>
            </span>
            <span>
              引擎 <b>Tiptap + SQLite</b>
            </span>
          </div>
        </div>
        <button className="set-btn">检查更新</button>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SecHead title="致谢与许可" hint="CREDITS" />
        <Row
          label={<span className="set-italic">字体</span>}
          desc="Newsreader · Inter Tight · JetBrains Mono · 思源宋体 SC"
        />
        <Row
          label={<span className="set-italic">开源依赖</span>}
          desc="Tiptap · Yjs · Drizzle · React · Electron Forge"
          control={<button className="set-btn">查看清单</button>}
        />
      </div>

      <div className="set-sec">
        <SecHead title="联系" hint="HELLO" />
        <Row
          label="写信给团队"
          desc={<span className="set-mono">hi@drifting.app</span>}
          control={<button className="set-btn">写邮件</button>}
        />
        <Row
          label="提交反馈"
          desc="附带当前稿件上下文的报告（可选）。"
          control={<button className="set-btn">反馈…</button>}
        />
      </div>

      <p
        style={{
          margin: '48px 0 0',
          fontFamily: 'var(--font-serif)',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'hsl(var(--ink-4))',
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        为夜里不睡的写作人造。
        <br />
        —— 渡舟 团队
      </p>
    </section>
  );
}
