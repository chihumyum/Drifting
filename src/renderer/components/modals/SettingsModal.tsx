import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  byokKeychain,
  agentApiKeychain,
  maskBYOK,
  type BYOKProvider,
} from '../../lib/byok-keychain';
import { apiClient } from '../../lib/axios-config';
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
  type CopilotTaskId,
  type DateFormat,
  type AiMode,
  type AgentAuth,
  type AgentEffort,
  AGENT_MODEL_OPTIONS,
  AGENT_EFFORT_OPTIONS,
  type FocusLineMode,
  type LineHeight,
  type LocaleCode,
  type ModelTier,
  type ParagraphIndent,
  type ThemeMode,
} from '../../store/settings-store';
import { SHADOW_TIERS, SHADOW_BYOK_MODELS } from '../../lib/shadow/model-routing';
import { useAuthStore } from '../../store/auth';
import { useProjectStore } from '../../store/project-store';
import { useAgentChatStore } from '../../store/agent-chat-store';
import {
  createAgentConversationRepository,
  type AgentConversationUsage,
} from '../../sqlite-repo/agent-conversation-repo';
import { createAiUsageRepository, type AiUsageSummary } from '../../sqlite-repo/ai-usage-repo';
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
  | 'trash'
  | 'appearance'
  | 'editor'
  | 'language'
  | 'copilot'
  | 'shadow'
  | 'agent'
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
  { id: 'trash', group: '我的账户', glyph: '⌫', label: '回收站' },
  { id: 'appearance', group: '偏好', glyph: '☀', label: '外观' },
  { id: 'editor', group: '偏好', glyph: '§', label: '编辑器' },
  { id: 'language', group: '偏好', glyph: '文', label: '语言' },
  { id: 'copilot', group: '智能', glyph: '⌁', label: 'Copilot · 副手' },
  { id: 'shadow', group: '智能', glyph: '◐', label: 'Shadow Agent' },
  { id: 'agent', group: '智能', glyph: '✦', label: 'General Agent' },
  { id: 'keys', group: '控制', glyph: '⌨', label: '快捷键' },
  { id: 'sync', group: '控制', glyph: '⇅', label: '同步与数据' },
  { id: 'privacy', group: '关于', glyph: '⚷', label: '隐私' },
  { id: 'about', group: '关于', glyph: '渡', label: '关于 Drifting' },
];

const RAIL_IDS = new Set<RailId>([
  'account',
  'subscription',
  'trash',
  'appearance',
  'editor',
  'language',
  'copilot',
  'shadow',
  'agent',
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
    const apply = () => {
      // Set the rail highlight here (deferred in the rAF, not synchronously in
      // the effect body) so it lands together with the scroll.
      if (hasDeepLink) setActive(target);
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
          <TrashRailPanel registerRef={(el) => (panelRefs.current.trash = el ?? undefined)} />
          <AppearancePanel
            registerRef={(el) => (panelRefs.current.appearance = el ?? undefined)}
          />
          <EditorPanel registerRef={(el) => (panelRefs.current.editor = el ?? undefined)} />
          <LanguagePanel registerRef={(el) => (panelRefs.current.language = el ?? undefined)} />
          <CopilotPanel registerRef={(el) => (panelRefs.current.copilot = el ?? undefined)} />
          <ShadowPanel registerRef={(el) => (panelRefs.current.shadow = el ?? undefined)} />
          <AgentPanel
            open={isOpen}
            registerRef={(el) => (panelRefs.current.agent = el ?? undefined)}
          />
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
  const tier = useSettingsStore((s) => s.copilotTier);
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
    // Mount fetch: reload() flips setLoading(true) then fetches. This is the
    // legitimate "load on mount" pattern the rule can't infer through the
    // async callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

const SHADOW_USAGE_FEATURE_LABEL: Record<string, string> = {
  'shadow:review': '章节审阅 · CI',
  'shadow:arc': '弧线派生',
};

const EMPTY_USAGE_SUMMARY: AiUsageSummary = {
  total: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  byFeature: [],
};

// Start of the current month (UTC), ISO — the window the usage panel sums over.
function monthStartISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// REAL local usage — sums the `ai_usage` rows recorded by recordShadowUsage for
// Shadow calls that executed on this client (direct/BYOK). Hosted usage is metered
// server-side and intentionally NOT shown here. Tokens only (no cost/$, no quota:
// BYOK has no hosted budget). Rendered as a section INSIDE the Shadow panel.
function ShadowUsageSection() {
  const [scope, setScope] = useState<'month' | 'all'>('month');
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = scope === 'month' ? monthStartISO() : undefined;
    createAiUsageRepository()
      .summary({ featurePrefix: 'shadow:', since })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(EMPTY_USAGE_SUMMARY);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const s = summary ?? EMPTY_USAGE_SUMMARY;
  const totalTokens = s.total.inputTokens + s.total.outputTokens;

  return (
    <>
      <div className="set-sec">
        <SecHead title="本地用量" hint="USAGE" />
        <p className="set-row__desc" style={{ margin: '-4px 0 8px' }}>
          只统计<b>在本机直连执行</b>的 Shadow 调用（章节审阅 + 弧线派生）的 token；托管用量在服务端计量、不在此处，自带 Key 无配额。
        </p>
        <Seg<'month' | 'all'>
          value={scope}
          options={[
            { value: 'month', label: '本月' },
            { value: 'all', label: '累计' },
          ]}
          onChange={setScope}
        />
      </div>

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
          Tokens（输入 + 输出）
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 36,
            color: 'hsl(var(--ink-1))',
            marginTop: 6,
          }}
        >
          {totalTokens.toLocaleString()}
        </div>
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'hsl(var(--ink-4))',
          }}
        >
          <span>
            <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.calls.toLocaleString()}</b> 次调用
          </span>
          <span>
            输入 <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.inputTokens.toLocaleString()}</b>
          </span>
          <span>
            输出 <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.outputTokens.toLocaleString()}</b>
          </span>
          {s.total.cachedTokens > 0 && (
            <span>
              缓存{' '}
              <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.cachedTokens.toLocaleString()}</b>
            </span>
          )}
        </div>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SecHead title="按能力" hint="BY FEATURE" />
        {s.byFeature.length === 0 ? (
          <p className="set-row__desc" style={{ margin: '4px 0 0' }}>
            还没有本地用量记录。跑一次章节审阅或弧线派生后，token 用量会出现在这里。
          </p>
        ) : (
          s.byFeature.map((f) => (
            <Row
              key={f.feature}
              label={SHADOW_USAGE_FEATURE_LABEL[f.feature] ?? f.feature}
              desc={`${f.calls.toLocaleString()} 次调用`}
              control={
                <span className="set-mono" style={{ fontSize: 12, color: 'hsl(var(--ink-2))' }}>
                  {(f.inputTokens + f.outputTokens).toLocaleString()} tok
                </span>
              }
            />
          ))
        )}
      </div>
    </>
  );
}

function AppearancePanel({ registerRef }: { registerRef: RegisterRef }) {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
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


function GroupHead({ label, hint, desc }: { label: string; hint?: string; desc?: string }) {
  return (
    <div style={{ margin: '26px 0 6px', paddingTop: 18, borderTop: '1px solid hsl(var(--rule))' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'hsl(var(--ink-1))' }}>{label}</div>
        {hint && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'hsl(var(--ink-4))',
            }}
          >
            {hint}
          </div>
        )}
      </div>
      {desc && (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, lineHeight: 1.6 }}>{desc}</div>
      )}
    </div>
  );
}

/** Connect / status for the Agent's credentials (Claude OAuth or hosted). */
function AgentAuthRow({ auth }: { auth: AgentAuth }) {
  const api = window.electronAPI?.agent;
  const [status, setStatus] = useState<{
    byokConnected: boolean;
    apiKeyConnected: boolean;
    hostedAvailable: boolean;
  } | null>(null);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // API-key path state (the key lives only in the keychain — see agentApiKeychain).
  const [keyStored, setKeyStored] = useState<string | null>(null);
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  const refresh = useCallback(() => {
    if (!api) return;
    void api
      .authStatus()
      .then(setStatus)
      .catch(() =>
        setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
      );
  }, [api]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void agentApiKeychain.get().then((v) => {
      if (!cancelled) setKeyStored(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!api) return null;

  const connect = async () => {
    setErr(null);
    await api.authPrepare();
    setAwaitingCode(true);
  };
  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    const r = await api.authSubmitCode(code.trim());
    setBusy(false);
    if (r.ok) {
      setAwaitingCode(false);
      setCode('');
      setErr(null);
      refresh();
      events.emit('agent:auth-changed');
    } else {
      setErr(r.error);
    }
  };
  const disconnect = async () => {
    await api.authLogout();
    refresh();
    events.emit('agent:auth-changed');
  };

  const saveKey = async () => {
    const v = keyDraft.trim();
    if (!v) {
      await agentApiKeychain.clear();
      setKeyStored(null);
    } else {
      await agentApiKeychain.set(v);
      setKeyStored(v);
    }
    setKeyDraft('');
    setKeyEditing(false);
    refresh();
    events.emit('agent:auth-changed');
  };
  const clearKey = async () => {
    await agentApiKeychain.clear();
    setKeyStored(null);
    refresh();
    events.emit('agent:auth-changed');
  };

  if (auth === 'hosted') {
    const ok = !!status?.hostedAvailable;
    return (
      <div className="set-sec">
        <SecHead title="状态" hint="HOSTED" />
        <Row
          label={ok ? '已就绪' : '未登录'}
          desc={
            ok
              ? '已登录 Drifting，可用托管额度调用 Agent。'
              : '托管 Agent 需要先登录 Drifting 账号（在「账户」中登录）。'
          }
          control={
            <span
              className="set-mono"
              style={{ color: ok ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))' }}
            >
              {ok ? '● 可用' : '○ 未就绪'}
            </span>
          }
        />
      </div>
    );
  }

  if (auth === 'apikey') {
    const hasKey = !!keyStored;
    return (
      <div className="set-sec">
        <SecHead title="Anthropic API Key" hint="PAY-AS-YOU-GO" />
        {keyEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>粘贴 Anthropic API Key（sk-ant-…）：</div>
            <input
              className="set-input set-input--mono"
              style={{ minWidth: 320 }}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="sk-ant-..."
              autoFocus
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="set-btn set-btn--primary" onClick={saveKey}>
                保存
              </button>
              <button
                className="set-btn"
                onClick={() => {
                  setKeyDraft('');
                  setKeyEditing(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : hasKey ? (
          <Row
            label="已填写"
            desc="Agent 将用你的 Anthropic API Key（按量付费）直连 Anthropic。密钥仅存于本机 Keychain。"
            control={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code className="set-mono">{maskBYOK(keyStored)}</code>
                <button className="set-btn" onClick={() => setKeyEditing(true)}>
                  编辑
                </button>
                <button className="set-btn set-btn--danger" onClick={clearKey}>
                  删除
                </button>
              </div>
            }
          />
        ) : (
          <Row
            label="未填写"
            desc="使用 Anthropic Console 的 API Key（按量付费，无需订阅 / OAuth）。"
            control={
              <button className="set-btn set-btn--primary" onClick={() => setKeyEditing(true)}>
                填入 Key
              </button>
            }
          />
        )}
      </div>
    );
  }

  const connected = !!status?.byokConnected;
  return (
    <div className="set-sec">
      <SecHead title="Claude 账号 · OAuth" hint="BYOK" />
      {connected ? (
        <Row
          label="已连接"
          desc="Agent 将用你的 Claude 账号直连 Anthropic。"
          control={
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              断开
            </button>
          }
        />
      ) : !awaitingCode ? (
        <Row
          label="未连接"
          desc="用你的 Claude 账号（Max/Pro）授权。点击后打开浏览器，把页面上的 code 粘回来。"
          control={
            <button className="set-btn set-btn--primary" onClick={connect}>
              连接 Claude
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>粘贴授权 code：</div>
          <input
            className="set-input set-input--mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="authorization code"
            autoFocus
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="set-btn set-btn--primary" disabled={busy} onClick={submit}>
              {busy ? '验证中…' : '提交'}
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setAwaitingCode(false);
                setErr(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {err && (
        <div
          style={{
            fontSize: 11.5,
            color: 'hsl(var(--danger, 0 70% 50%))',
            marginTop: 4,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {err}
        </div>
      )}
    </div>
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

  const copilotAiMode = useSettingsStore((s) => s.copilotAiMode);
  const activeProvider = useSettingsStore((s) => s.copilotByokProvider);
  const setCopilotByokProvider = useSettingsStore((s) => s.setCopilotByokProvider);
  const isActive = activeProvider === provider;

  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const testConnection = async () => {
    if (!stored) return;
    setTestState('testing');
    setTestMsg('');
    try {
      // Send the key for THIS row (not the active one) so the user can verify a
      // specific provider's key. Server makes a tiny call and reports ok/fail.
      const res = await apiClient.request<{ ok?: boolean; message?: string }>({
        method: 'POST',
        url: '/api/ai/byok/test',
        headers: { 'X-AI-Provider': provider, 'X-AI-Provider-Key': stored },
      });
      if (res.data?.ok) {
        setTestState('ok');
      } else {
        setTestState('fail');
        setTestMsg(res.data?.message ?? '密钥无效');
      }
    } catch {
      setTestState('fail');
      setTestMsg('请求失败（服务器未启动或网络问题）');
    }
  };

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
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await byokKeychain.clear(provider);
    setStored(null);
    events.emit('byok:keys-changed');
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
            <button className="set-btn" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing' ? '测试中…' : '测试连接'}
            </button>
            {testState === 'ok' && (
              <span className="set-mono" style={{ color: '#2e7d52' }}>
                ✓ 可用
              </span>
            )}
            {testState === 'fail' && (
              <span className="set-mono" style={{ color: '#c0392b' }}>
                ✗ {testMsg}
              </span>
            )}
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              编辑密钥
            </button>
            {copilotAiMode === 'byok' &&
              (isActive ? (
                <span className="set-mono" style={{ color: '#4D6BFE', fontWeight: 600 }}>
                  ✓ 当前 BYOK
                </span>
              ) : (
                <button className="set-btn" onClick={() => setCopilotByokProvider(provider)}>
                  设为当前
                </button>
              ))}
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

// Shadow model routing modes — like Copilot's, but Shadow has its own slice
// (governs BOTH chapter-CI review and element-arc derive). BYOK is DeepSeek-only
// for now (the substrate routes DeepSeek directly; Sonnet is hosted-only).
const SHADOW_AI_MODES: { value: AiMode; kicker: string; name: string; desc: string }[] = [
  {
    value: 'hosted',
    kicker: 'HOSTED',
    name: '托管',
    desc: '走 Drifting 的通道与额度。只需在下方选一个能力档位（低 / 中 / 高）。',
  },
  {
    value: 'byok',
    kicker: 'BYOK',
    name: '自带 Key',
    desc: '用你自己的 DeepSeek Key（与 Copilot 共用 Keychain 里的同一条），在下方选模型。',
  },
];

// Shadow BYOK shares Copilot's DeepSeek keychain entry (byok.deepseek) — it has no
// key entry of its own. This makes that borrow VISIBLE: shows connected/未连接 and
// jumps to the Copilot panel (where the key is actually entered) so the user isn't
// left with a silent no-key BYOK that only errors at run time.
function ShadowDeepseekKeyStatus() {
  const connected = useByokConnected('deepseek');
  const jumpToCopilot = () =>
    document.getElementById('copilot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (connected === null) return null;
  return (
    <Row
      label="DeepSeek 密钥"
      desc="Shadow 自带 Key 与 Copilot 共用同一条 DeepSeek 密钥（Keychain）。在「Copilot · 副手」面板填写或更换。"
      control={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="set-mono"
            style={{ fontSize: 12, color: connected ? '#2e7d52' : 'hsl(38 80% 42%)' }}
          >
            {connected ? '✓ 已连接' : '⚠ 未连接'}
          </span>
          <button className="set-btn" onClick={jumpToCopilot}>
            前往 Copilot 填写
          </button>
        </div>
      }
    />
  );
}

// Shadow Agent settings — model routing for the two Shadow capabilities: chapter
// continuity review (CI) and element-arc derivation. Both read resolveShadowModel()
// (lib/shadow/model-routing.ts). Hosted = a capability tier the server maps to a
// concrete model (低 flash / 中 pro / 高 sonnet); BYOK = pin a DeepSeek model.
function ShadowPanel({ registerRef }: { registerRef: RegisterRef }) {
  const shadowAiMode = useSettingsStore((s) => s.shadowAiMode);
  const setShadowAiMode = useSettingsStore((s) => s.setShadowAiMode);
  const shadowTier = useSettingsStore((s) => s.shadowTier);
  const setShadowTier = useSettingsStore((s) => s.setShadowTier);
  const shadowByokModel = useSettingsStore((s) => s.shadowByokModel);
  const setShadowByokModel = useSettingsStore((s) => s.setShadowByokModel);

  return (
    <section className="set-panel" ref={registerRef} id="shadow">
      <PanelHead
        kicker="SHADOW · 影"
        title="影，替你巡查全书。"
        sub={
          <>
            Shadow 的两个能力——章节连贯审阅（CI）与元素弧线派生——共用这里的模型档位。
            托管按能力档位走 Drifting 额度；自带 Key 用你自己的 DeepSeek 额度。
            <span className="set-italic"> 你的密钥仅存于本机 Keychain，不上传服务器。</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title="AI 调用方式" hint="ROUTING" />
        <div className="set-tiers">
          {SHADOW_AI_MODES.map((m) => (
            <button
              key={m.value}
              className={'set-tier' + (shadowAiMode === m.value ? ' set-tier--active' : '')}
              onClick={() => setShadowAiMode(m.value)}
            >
              <div className="set-tier__kicker">{m.kicker}</div>
              <div className="set-tier__name">{m.name}</div>
              <div className="set-tier__desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {shadowAiMode === 'hosted' ? (
        <div className="set-sec">
          <SecHead title="能力档位" hint="TIER" />
          <div className="set-tiers">
            {SHADOW_TIERS.map((t) => (
              <button
                key={t.value}
                className={'set-tier' + (shadowTier === t.value ? ' set-tier--active' : '')}
                onClick={() => setShadowTier(t.value)}
              >
                <div className="set-tier__kicker">{t.kicker}</div>
                <div className="set-tier__name">{t.name}</div>
                <div className="set-tier__desc">{t.desc}</div>
              </button>
            ))}
          </div>
          <p className="set-row__desc" style={{ margin: '8px 0 0' }}>
            「高 · Sonnet」需托管订阅（服务端调用）。本地直连仅支持「低 / 中」DeepSeek 档位——若选了高，
            review 会自动回退到中档、arc 派生会提示需托管。
          </p>
        </div>
      ) : (
        <div className="set-sec">
          <SecHead title="自带密钥 · BYOK" hint="DEEPSEEK" />
          <ShadowDeepseekKeyStatus />
          <Row
            label="DeepSeek 模型"
            desc="自带 Key 时 Shadow 实际调用的模型。"
            control={
              <select
                className="set-input"
                style={{ minWidth: 220 }}
                value={shadowByokModel}
                onChange={(e) => setShadowByokModel(e.target.value)}
              >
                {SHADOW_BYOK_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            }
          />
        </div>
      )}

      <ShadowUsageSection />
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

const COPILOT_TIERS: { value: ModelTier; kicker: string; name: string; desc: string }[] = [
  { value: 'lite', kicker: 'LITE', name: '轻量', desc: '速度优先。短建议、实体抽取等高吞吐任务。' },
  { value: 'standard', kicker: 'STANDARD', name: '标准', desc: '日常默认。结构、连贯、润色都够用。' },
  { value: 'pro', kicker: 'PRO', name: '深思', desc: '长上下文、长任务推理。慢一点，更稳。' },
];

const COPILOT_AI_MODES: { value: AiMode; kicker: string; name: string; desc: string }[] = [
  {
    value: 'hosted',
    kicker: 'HOSTED',
    name: '托管',
    desc: '走 Drifting 的通道与额度，开箱即用。只需在上方选一个能力档位。',
  },
  {
    value: 'byok',
    kicker: 'BYOK',
    name: '自带 Key',
    desc: '用你自己的 Key 调用（在下方选 provider、填模型与 Key），不计入托管额度。',
  },
];

// Known models per BYOK provider — drives the Copilot model dropdown so the user
// picks instead of hand-typing a model id. Only ids the codebase already blesses
// (deepseek v4 flash/pro, the Agent catalog's pinned Claude ids, the GoogleModel
// union); openai has no sanctioned catalog here, so it falls back to 默认/自定义.
// The model is still resolved server-side (synced via preferences) — this is a
// UX layer over the same copilotByokModel value, NOT new routing.
const COPILOT_BYOK_MODELS: Record<BYOKProvider, { value: string; label: string }[]> = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek Flash · 快' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek Pro · 稳' },
  ],
  anthropic: [
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  google: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  openai: [],
};

const BYOK_PROVIDER_LABEL: Record<BYOKProvider, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

// Live keychain-connected status for one BYOK provider. Re-reads on mount and on
// any 'byok:keys-changed' (ProviderRow connect/disconnect) so indicators that
// don't own ProviderRow's local state stay in sync. null = still loading.
function useByokConnected(provider: BYOKProvider): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void byokKeychain.get(provider).then((k) => {
        if (!cancelled) setConnected(!!k);
      });
    };
    read();
    events.on('byok:keys-changed', read);
    return () => {
      cancelled = true;
      events.off('byok:keys-changed', read);
    };
  }, [provider]);
  return connected;
}

// Sentinel select value for the "custom model id" escape hatch.
const BYOK_MODEL_CUSTOM = '__custom__';

// Copilot BYOK model picker: a dropdown of known models for the active provider
// (+ provider-default + 自定义…), replacing the old hand-typed model-id input.
function CopilotByokModelPicker() {
  const provider = useSettingsStore((s) => s.copilotByokProvider);
  const model = useSettingsStore((s) => s.copilotByokModel);
  const setModel = useSettingsStore((s) => s.setCopilotByokModel);
  const known = COPILOT_BYOK_MODELS[provider] ?? [];
  const inKnown = model === '' || known.some((m) => m.value === model);
  const [customOpen, setCustomOpen] = useState(false);
  const showCustom = customOpen || (model !== '' && !inKnown);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240 }}>
      <select
        className="set-input"
        style={{ minWidth: 240 }}
        value={showCustom ? BYOK_MODEL_CUSTOM : model}
        onChange={(e) => {
          const v = e.target.value;
          if (v === BYOK_MODEL_CUSTOM) {
            setCustomOpen(true);
          } else {
            setCustomOpen(false);
            setModel(v);
          }
        }}
      >
        <option value="">provider 默认（留空）</option>
        {known.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
        <option value={BYOK_MODEL_CUSTOM}>自定义…</option>
      </select>
      {showCustom && (
        <input
          className="set-input set-input--mono"
          style={{ minWidth: 240 }}
          placeholder="输入完整 model id"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      )}
    </div>
  );
}

// Warns when BYOK is selected but the ACTIVE provider has no key — the request
// would silently fall back to hosted (byok-headers.ts). Removes the "filled a key
// but forgot 设为当前 / selected BYOK with no key" silent trap.
function CopilotByokWarning() {
  const provider = useSettingsStore((s) => s.copilotByokProvider);
  const connected = useByokConnected(provider);
  if (connected !== false) return null;
  return (
    <div
      style={{
        margin: '0 0 10px',
        padding: '9px 12px',
        borderRadius: 6,
        background: 'hsl(38 92% 50% / 0.1)',
        border: '1px solid hsl(38 80% 50% / 0.35)',
        fontSize: 12.5,
        lineHeight: 1.6,
        color: 'hsl(var(--ink-2))',
      }}
    >
      当前 BYOK provider「{BYOK_PROVIDER_LABEL[provider]}」未连接密钥 —— 实际调用会
      <b>静默回退托管</b>。请在下方为它「连接」密钥，或把已连接的 provider「设为当前」。
    </div>
  );
}

function CopilotPanel({ registerRef }: { registerRef: RegisterRef }) {
  const copilotTier = useSettingsStore((s) => s.copilotTier);
  const setCopilotTier = useSettingsStore((s) => s.setCopilotTier);
  const copilotAiMode = useSettingsStore((s) => s.copilotAiMode);
  const setCopilotAiMode = useSettingsStore((s) => s.setCopilotAiMode);
  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const setAutoTrigger = useSettingsStore((s) => s.setCopilotAutoTrigger);
  const copilotInDrift = useSettingsStore((s) => s.copilotInDrift);
  const setCopilotInDrift = useSettingsStore((s) => s.setCopilotInDrift);
  const generateSummaries = useSettingsStore((s) => s.copilotGenerateSummaries);
  const setGenerateSummaries = useSettingsStore((s) => s.setCopilotGenerateSummaries);
  const sectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const setSectionSize = useSettingsStore((s) => s.setCopilotSummarySectionSize);

  return (
    <section className="set-panel" ref={registerRef} id="copilot">
      <PanelHead
        kicker="COPILOT · 副手"
        title="把琐事交给一个安静的副手。"
        sub={
          <>
            正文里的轻量补全、实体抽取、润色等结构化任务。托管模式只需选能力档位；自带 Key
            可指定 provider 与模型。
            <span className="set-italic"> 你的密钥仅存于本机 Keychain，不上传服务器。</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title="AI 调用方式" hint="ROUTING" />
        <div className="set-tiers">
          {COPILOT_AI_MODES.map((m) => (
            <button
              key={m.value}
              className={'set-tier' + (copilotAiMode === m.value ? ' set-tier--active' : '')}
              onClick={() => setCopilotAiMode(m.value)}
            >
              <div className="set-tier__kicker">{m.kicker}</div>
              <div className="set-tier__name">{m.name}</div>
              <div className="set-tier__desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {copilotAiMode === 'hosted' ? (
        <div className="set-sec">
          <SecHead title="能力档位" hint="TIER" />
          <div className="set-tiers">
            {COPILOT_TIERS.map((t) => (
              <button
                key={t.value}
                className={'set-tier' + (copilotTier === t.value ? ' set-tier--active' : '')}
                onClick={() => setCopilotTier(t.value)}
              >
                <div className="set-tier__kicker">{t.kicker}</div>
                <div className="set-tier__name">{t.name}</div>
                <div className="set-tier__desc">{t.desc}</div>
              </button>
            ))}
          </div>
          <p className="set-row__desc" style={{ margin: '8px 0 0' }}>
            档位是「能力档」，具体模型由服务端按档位选择（所以这里不显示模型名）。想精确指定某个模型，请改用「自带 Key」。
          </p>
        </div>
      ) : (
        <>
          <div className="set-sec">
            <SecHead title="自带密钥 · BYOK" hint="4 PROVIDERS" />
            <CopilotByokWarning />
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
            <SecHead title="模型" hint="MODEL" />
            <Row
              label="指定模型"
              desc="当前 provider 下要用的模型（留空 = 由服务端选该 provider 的默认模型；列表外的可选「自定义…」手填 id）。"
              control={<CopilotByokModelPicker />}
            />
          </div>
        </>
      )}

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
        <SecHead title="自动任务" hint="TASKS" />
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

const fmtUsageTok = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);
const fmtUsageUsd = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const fmtConvTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
};

function AgentUsageSection({ open }: { open: boolean }) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [rows, setRows] = useState<AgentConversationUsage[]>([]);
  // Two reporting windows, à la the Shadow usage panel: this-month vs all-time.
  // Defaults to all-time: usage entries written before per-turn timestamps existed
  // are undated, so they only surface under 累计 — landing there shows real numbers
  // instead of a misleading 本月 = 0 until fresh, dated turns accrue.
  const [scope, setScope] = useState<'month' | 'all'>('all');

  // Reload on open / project / scope change (the modal stays mounted while
  // closed). All setState happens in the async callbacks, never synchronously.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    const since = scope === 'month' ? monthStartISO() : undefined;
    void createAgentConversationRepository()
      .usageByProject(projectId, { since })
      .then((u) => {
        if (!cancelled) setRows(u);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, scope]);

  // Totals sum EVERY conversation in-window, deleted or not — the spend was real,
  // so deleting a chat must not shrink the usage figures.
  const totals = rows.reduce(
    (a, r) => ({
      input: a.input + r.inputTokens,
      output: a.output + r.outputTokens,
      cost: a.cost + r.costUsd,
      turns: a.turns + r.turns,
    }),
    { input: 0, output: 0, cost: 0, turns: 0 },
  );
  const withUsage = rows.filter((r) => r.inputTokens + r.outputTokens > 0);
  // The manageable history list is live conversations only (all of them, not
  // window-scoped — you manage every chat regardless of when it was last used).
  const live = rows.filter((r) => !r.deletedAt);
  const scopeLabel = scope === 'month' ? '本月' : '累计';

  // Soft-delete through the chat store so the right-rail Companion (if bound to
  // this project) drops the conversation too — abort an in-flight turn, clear the
  // active pointer, refresh its list. Persistence (repo.softDelete) runs even when
  // the store isn't bound, so deletion is safe either way. We only MARK the row
  // deleted locally (not remove it) so its usage stays in the totals above.
  const handleDelete = (id: string) => {
    void useAgentChatStore.getState().deleteConversation(id);
    const now = new Date().toISOString();
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, deletedAt: now } : r)));
  };

  // Bulk soft-delete behind a confirm — clearing all is easy to fire by accident.
  const handleClearAll = () => {
    if (live.length === 0) return;
    if (!window.confirm(`清空全部对话历史？将移除本项目的 ${live.length} 条 Agent 对话。`)) return;
    void useAgentChatStore.getState().clearConversations();
    const now = new Date().toISOString();
    setRows((rs) => rs.map((r) => (r.deletedAt ? r : { ...r, deletedAt: now })));
  };

  const card = (label: string, value: string, sub?: string) => (
    <div
      style={{
        flex: 1,
        border: '1px solid hsl(var(--rule))',
        borderRadius: 5,
        background: 'hsl(var(--surface))',
        padding: '14px 16px',
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
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 30,
          color: 'hsl(var(--ink-1))',
          marginTop: 6,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'hsl(var(--ink-4))',
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );

  return (
    <>
      <GroupHead
        label="用量"
        hint="USAGE"
        desc="本项目里 Agent 用了多少 token、花了多少钱。统计自每轮返回的用量（输入含缓存读取）；自付费模式下为你的实际花费，数据保存在本地。按本月 / 累计两个口径查看。"
      />

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>打开一个项目后查看其 Agent 用量。</div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Seg<'month' | 'all'>
              value={scope}
              options={[
                { value: 'month', label: '本月' },
                { value: 'all', label: '累计' },
              ]}
              onChange={setScope}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {card(
              `${scopeLabel} Token`,
              fmtUsageTok(totals.input + totals.output),
              `↑${fmtUsageTok(totals.input)} ↓${fmtUsageTok(totals.output)}`,
            )}
            {card(`${scopeLabel}费用`, fmtUsageUsd(totals.cost))}
            {card('对话 / 轮次', `${withUsage.length} / ${totals.turns}`)}
          </div>
        </>
      )}

      <GroupHead
        label="对话历史"
        hint="HISTORY"
        desc="本项目的所有 Agent 对话。删除为软删除，会与右栏「历史」同步移除，不影响其它项目。"
      />

      {projectId && live.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '2px 0 8px' }}>
          <button
            type="button"
            onClick={handleClearAll}
            style={{
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-3))',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 5,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'hsl(var(--ink-1))';
              e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'hsl(var(--ink-3))';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            清空历史
          </button>
        </div>
      )}

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>打开一个项目后管理其对话历史。</div>
      ) : live.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13, padding: '8px 0' }}>
          还没有对话 — 给 Agent 发一条消息试试。
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 5,
            overflow: 'hidden',
          }}
        >
          {live.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderTop: i === 0 ? 'none' : '1px solid hsl(var(--rule))',
                fontSize: 12.5,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'hsl(var(--ink-1))',
                }}
              >
                {r.title || '未命名'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'hsl(var(--ink-4))',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtConvTime(r.updatedAt)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.inputTokens + r.outputTokens > 0
                  ? `↑${fmtUsageTok(r.inputTokens)} ↓${fmtUsageTok(r.outputTokens)}`
                  : '—'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'hsl(var(--ink-4))',
                  minWidth: 56,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.costUsd > 0 ? fmtUsageUsd(r.costUsd) : '—'}
              </span>
              <button
                type="button"
                title="删除这条对话"
                onClick={() => handleDelete(r.id)}
                style={{
                  flexShrink: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'hsl(var(--ink-4))',
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                  padding: '2px 4px',
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(var(--ink-1))';
                  e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(var(--ink-4))';
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const AGENT_AUTH_OPTIONS: { value: AgentAuth; kicker: string; name: string; desc: string }[] = [
  {
    value: 'oauth',
    kicker: 'CLAUDE 账号',
    name: '自带 Claude',
    desc: '用你的 Claude 账号（Max/Pro）登录（OAuth），直连 Anthropic，不计入托管额度。',
  },
  {
    value: 'apikey',
    kicker: 'API KEY',
    name: 'Anthropic Key',
    desc: '用 Anthropic Console 的 API Key（按量付费），无需订阅。密钥仅存于本机 Keychain。',
  },
  {
    value: 'hosted',
    kicker: 'HOSTED',
    name: '托管订阅',
    desc: '走 Drifting 的通道与额度，无需你自己的 Claude 账号或 Key。',
  },
];

function AgentPanel({ open, registerRef }: { open: boolean; registerRef: RegisterRef }) {
  const agentAuth = useSettingsStore((s) => s.agentAuth);
  const setAgentAuth = useSettingsStore((s) => s.setAgentAuth);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentEffort = useSettingsStore((s) => s.agentEffort);
  const setAgentEffort = useSettingsStore((s) => s.setAgentEffort);
  const agentThinking = useSettingsStore((s) => s.agentThinking);
  const setAgentThinking = useSettingsStore((s) => s.setAgentThinking);

  return (
    <section className="set-panel" ref={registerRef} id="agent">
      <PanelHead
        kicker="GENERAL AGENT · 对话"
        title="右栏那位能动手的 Agent。"
        sub={
          <>
            对话式、能读写整本稿子的 Agent（Claude Agent SDK）。可用你的 Claude 账号、Anthropic
            API Key，或走托管订阅；模型与推理强度可细调。
            <span className="set-italic"> 凭据仅存于本机，不上传服务器。</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title="调用方式" hint="ROUTING" />
        <div className="set-tiers">
          {AGENT_AUTH_OPTIONS.map((m) => (
            <button
              key={m.value}
              className={'set-tier' + (agentAuth === m.value ? ' set-tier--active' : '')}
              onClick={() => setAgentAuth(m.value)}
            >
              <div className="set-tier__kicker">{m.kicker}</div>
              <div className="set-tier__name">{m.name}</div>
              <div className="set-tier__desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <AgentAuthRow auth={agentAuth} />

      <div className="set-sec">
        <SecHead title="模型" hint="MODEL" />
        <Row
          label="对话模型"
          desc="「跟随最新」用别名自动指向各档最新版本；也可固定到具体版本。默认则交给订阅 / CLI。"
          control={
            <select
              className="set-input"
              style={{ minWidth: 220 }}
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
            >
              {AGENT_MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title="推理参数" hint="REASONING" />
        <Row
          label="扩展思考"
          desc="开启后模型会先「想」再答，复杂任务更稳；关闭更快更省。思考过程会显示在对话里。"
          control={
            <Toggle
              on={agentThinking === 'adaptive'}
              onChange={(on) => setAgentThinking(on ? 'adaptive' : 'off')}
            />
          }
        />
        <Row
          label="思考强度"
          desc="思考开启时生效。high 推理最深（默认），low 最快；xhigh / max 仅部分 Opus 版本支持。"
          control={
            <Seg<AgentEffort>
              value={agentEffort}
              options={AGENT_EFFORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={setAgentEffort}
            />
          }
        />
      </div>

      <AgentUsageSection open={open} />
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
      <PanelHead kicker="关于 · ABOUT" title="Drifting · 缀浮" sub="终极写作体验" />

      <div className="set-about">
        <div className="set-about__glyph">D</div>
        <div className="set-about__main">
          <div className="set-about__name">
            Drifting <em>缀浮</em>
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
      </p>
    </section>
  );
}
