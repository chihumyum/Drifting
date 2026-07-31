import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  byokKeychain,
  agentApiKeychain,
  maskBYOK,
  type BYOKProvider,
} from '../../lib/byok-keychain';
import { apiClient } from '../../lib/axios-config';
import { isByokOnly } from '../../lib/config';
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
  type AgentAuth,
  type AgentToolSearch,
  AGENT_MODEL_OPTIONS,
  AGENT_TOOL_SEARCH_OPTIONS,
  TYPEWRITER_POSITION_MAX,
  TYPEWRITER_POSITION_MIN,
  type EditorFontSource,
  type LocaleCode,
  type ParagraphIndent,
  type ThemeMode,
} from '../../store/settings-store';
import { SHADOW_BYOK_MODELS } from '../../lib/shadow/model-routing';
import { useAuthStore } from '../../store/auth';
import { useProjectStore } from '../../store/project-store';
import { useAgentChatStore } from '../../store/agent-chat-store';
import {
  createAgentConversationRepository,
  type AgentConversationUsage,
} from '../../sqlite-repo/agent-conversation-repo';
import {
  approvePendingMemory,
  createMemory,
  listLiveMemories,
  softDeleteMemory,
} from '../../usecase/useAgentMemory';
import type { AgentMemory, AgentMemoryKind } from '../../domain/agent-memory';
import { createAiUsageRepository, type AiUsageSummary } from '../../sqlite-repo/ai-usage-repo';
import { authClient } from '../../lib/auth-client';
import { TrashPanel } from '../TrashPanel';
import { refreshFeatureAccess, useFeatureAccessStore } from '../../lib/feature-access';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator, matchesAccelerator } from '../../lib/shortcuts';
import { UI_LOCALE_OPTIONS } from '../../lib/i18n';
import { exportAllProjectsAsRelationalMarkdown } from '../../services/export/relational-markdown.service';
import { generalAgentTransport } from '../../lib/agent/transport';
import { platform, type SystemFontFamily } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Switch } from '../ui/Switch';
import {
  getImportedProseFontMetadata,
  importProseFont,
  IMPORTED_PROSE_FONT_ACCEPT,
  ProseFontImportError,
  removeImportedProseFont,
  type ImportedProseFontMetadata,
} from '../../lib/prose-fonts';

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

interface RailBaseDef {
  id: RailId;
  groupKey: string;
  glyph: string;
  labelKey: string;
}

// Static rail definition. The subscription row's badge is filled in at
// render time from the actual cached plan — see SetRail.
const RAIL_BASE: RailBaseDef[] = [
  {
    id: 'account',
    groupKey: 'settings.groups.account',
    glyph: '◌',
    labelKey: 'settings.rail.account',
  },
  {
    id: 'subscription',
    groupKey: 'settings.groups.account',
    glyph: '¶',
    labelKey: 'settings.rail.subscription',
  },
  { id: 'trash', groupKey: 'settings.groups.account', glyph: '⌫', labelKey: 'settings.rail.trash' },
  {
    id: 'appearance',
    groupKey: 'settings.groups.preferences',
    glyph: '☀',
    labelKey: 'settings.rail.appearance',
  },
  {
    id: 'editor',
    groupKey: 'settings.groups.preferences',
    glyph: '§',
    labelKey: 'settings.rail.editor',
  },
  {
    id: 'language',
    groupKey: 'settings.groups.preferences',
    glyph: '文',
    labelKey: 'settings.rail.language',
  },
  {
    id: 'copilot',
    groupKey: 'settings.groups.intelligence',
    glyph: '⌁',
    labelKey: 'settings.rail.copilot',
  },
  {
    id: 'shadow',
    groupKey: 'settings.groups.intelligence',
    glyph: '◐',
    labelKey: 'settings.rail.shadow',
  },
  {
    id: 'agent',
    groupKey: 'settings.groups.intelligence',
    glyph: '✦',
    labelKey: 'settings.rail.agent',
  },
  { id: 'keys', groupKey: 'settings.groups.control', glyph: '⌨', labelKey: 'settings.rail.keys' },
  { id: 'sync', groupKey: 'settings.groups.control', glyph: '⇅', labelKey: 'settings.rail.sync' },
  {
    id: 'privacy',
    groupKey: 'settings.groups.about',
    glyph: '⚷',
    labelKey: 'settings.rail.privacy',
  },
  {
    id: 'about',
    groupKey: 'settings.groups.about',
    glyph: '渡',
    labelKey: 'settings.rail.about_app',
  },
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
  const { t } = useTranslation();
  return useMemo<RailDef[]>(() => {
    return RAIL_BASE.map((r) => {
      const base = {
        id: r.id,
        group: t(r.groupKey),
        glyph: r.glyph,
        label: t(r.labelKey),
      };
      if (r.id === 'subscription') {
        return { ...base, badge: { text: plan.toUpperCase() } };
      }
      return base;
    });
  }, [plan, t]);
}

export function SettingsModal({ isOpen, onClose, initialRailId }: SettingsModalProps) {
  const [active, setActive] = useState<RailId>('account');
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Partial<Record<RailId, HTMLElement>>>({});
  const RAIL = useRail();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchesAccelerator(e, 'Mod+F')) {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
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
      <SetHead
        query={query}
        setQuery={setQuery}
        searchInputRef={searchInputRef}
        onClose={onClose}
      />
      <div className="set-body">
        <SetRail items={filtered} active={active} onSelect={onRail} />
        <main className="set-main app-chrome app-island" ref={mainRef}>
          <AccountPanel registerRef={(el) => (panelRefs.current.account = el ?? undefined)} />
          <SubscriptionPanel
            registerRef={(el) => (panelRefs.current.subscription = el ?? undefined)}
          />
          <TrashRailPanel registerRef={(el) => (panelRefs.current.trash = el ?? undefined)} />
          <AppearancePanel registerRef={(el) => (panelRefs.current.appearance = el ?? undefined)} />
          <EditorPanel registerRef={(el) => (panelRefs.current.editor = el ?? undefined)} />
          <LanguagePanel registerRef={(el) => (panelRefs.current.language = el ?? undefined)} />
          <CopilotPanel
            credentialsActive={active === 'copilot'}
            registerRef={(el) => (panelRefs.current.copilot = el ?? undefined)}
          />
          <ShadowPanel
            credentialsActive={active === 'shadow'}
            registerRef={(el) => (panelRefs.current.shadow = el ?? undefined)}
          />
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
  searchInputRef,
  onClose,
}: {
  query: string;
  setQuery: (s: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = getPlatformRuntime();
  return (
    <div
      className="set-head app-chrome app-island"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      style={{ paddingLeft: runtime.isMacDesktop ? 86 : 18 }}
    >
      <div className="set-head__left">
        <button
          type="button"
          className="set-head__back"
          onClick={onClose}
          title={t('navigation.back')}
        >
          <span className="set-head__back-glyph" aria-hidden>
            ‹
          </span>
          <span>{t('navigation.back')}</span>
        </button>
        <div className="set-head__title">
          {t('settings.title')}{' '}
          <em>
            {t('settings.title_en')} · {t('settings.esc_close')}
          </em>
        </div>
      </div>

      <div className="set-head__search">
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 L14 14" />
        </svg>
        <input
          ref={searchInputRef}
          placeholder={t('settings.search_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>⌘F</kbd>
      </div>

      <button className="set-head__close" onClick={onClose} title={t('settings.close_with_esc')}>
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
  const { t } = useTranslation();
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
          <div className="set-rail__who-name">
            {user?.name ?? user?.email ?? t('settings.local_user')}
          </div>
          <div className="set-rail__who-meta">
            {tier.toUpperCase()} · {t('settings.model_tier')}
          </div>
        </div>
      </div>

      {groups.map((g) => (
        <div className="set-rail__group" key={g.name}>
          <div className="set-rail__group-title">{g.name}</div>
          {g.items.map((r) => (
            <button
              key={r.id}
              className={'set-rail__item' + (active === r.id ? ' set-rail__item--active' : '')}
              onClick={() => onSelect(r.id)}
            >
              <span className="set-rail__glyph">{r.glyph}</span>
              <span className="set-rail__label">{r.label}</span>
              {r.badge && (
                <span
                  className={
                    'set-rail__badge' + (r.badge.tone === 'warn' ? ' set-rail__badge--warn' : '')
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
  return <Switch checked={on} onCheckedChange={onChange} disabled={disabled} />;
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
  return <SegmentedControl value={value} options={options} onChange={onChange} />;
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

function SecHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="set-sec__head">
      <div className="set-sec__title">{title}</div>
      <div className="set-sec__head-right">
        {hint && <div className="set-sec__hint">{hint}</div>}
        {action}
      </div>
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
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // Inline editing state for name + email. Password gets its own modal-y
  // sub-form since it needs current + new + confirm.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailChangeSent, setEmailChangeSent] = useState(false);
  const [emailChangeCode, setEmailChangeCode] = useState('');
  const [emailChangeError, setEmailChangeError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

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
  const [sessions, setSessions] = useState<Awaited<
    ReturnType<typeof accountService.listSessions>
  > | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    void accountService
      .getDeletionStatus()
      .then(setDeletion)
      .catch(() => undefined);
    void accountService
      .listSessions()
      .then(setSessions)
      .catch(() => undefined);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleMarkdownExport = async () => {
    setExportBusy(true);
    setExportMessage(null);
    try {
      const result = await exportAllProjectsAsRelationalMarkdown();
      setExportMessage(t('settings.account.export_done', { count: result.documentCount }));
    } catch (error) {
      setExportMessage(
        t('settings.account.export_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setExportBusy(false);
    }
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
    const nextEmail = emailDraft.trim().toLowerCase();
    setSavingEmail(true);
    setEmailChangeError(null);
    try {
      if (!emailChangeSent) {
        await accountService.requestEmailChange(nextEmail);
        setEmailChangeSent(true);
        return;
      }
      await accountService.confirmEmailChange(nextEmail, emailChangeCode);
      await checkSession();
      setEmailDraft(null);
      setEmailChangeSent(false);
      setEmailChangeCode('');
    } catch (err) {
      setEmailChangeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEmail(false);
    }
  };

  const cancelEmailChange = () => {
    setEmailDraft(null);
    setEmailChangeSent(false);
    setEmailChangeCode('');
    setEmailChangeError(null);
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
      if (res.error) throw new Error(res.error.message || t('settings.account.send_failed'));
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
      if (res.error) throw new Error(res.error.message || t('settings.account.verify_failed'));
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

  const handleRevokeSession = async (id: string) => {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await accountService.revokeSession(id);
      const next = await accountService.listSessions();
      setSessions(next);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  };

  const handleRequestDeletion = async () => {
    if (!window.confirm(t('settings.account.delete_confirm'))) return;
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
        kicker={t('settings.account.kicker')}
        title={t('settings.account.title')}
        sub={t('settings.account.sub')}
      />

      <div className="set-sec">
        <SecHead title={t('settings.account.profile')} hint="PUBLIC" />
        <Row
          label={t('settings.account.display_name')}
          desc={t('settings.account.display_name_desc')}
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
                  {t('settings.common.save')}
                </button>
                <button className="set-btn" onClick={() => setNameDraft(null)}>
                  {t('settings.common.cancel')}
                </button>
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value">
                  {user?.name ?? t('settings.account.not_set')}
                </span>
                <button className="set-field__edit" onClick={() => setNameDraft(user?.name ?? '')}>
                  {t('settings.common.edit')}
                </button>
              </div>
            )
          }
        />
        <Row
          label={t('settings.account.email')}
          desc={t('settings.account.email_desc')}
          control={
            emailDraft !== null ? (
              <>
                <input
                  className="set-input set-input--mono"
                  type="email"
                  value={emailDraft}
                  onChange={(e) => {
                    setEmailDraft(e.target.value);
                    setEmailChangeSent(false);
                    setEmailChangeCode('');
                    setEmailChangeError(null);
                  }}
                  disabled={savingEmail}
                  autoFocus
                />
                {emailChangeSent && (
                  <input
                    className="set-input set-input--mono"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t('settings.account.otp_placeholder')}
                    value={emailChangeCode}
                    onChange={(e) =>
                      setEmailChangeCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    disabled={savingEmail}
                    autoFocus
                  />
                )}
                <button
                  className="set-btn set-btn--primary"
                  onClick={handleSaveEmail}
                  disabled={
                    savingEmail ||
                    emailDraft.trim().toLowerCase() === user?.email.toLowerCase() ||
                    (emailChangeSent && emailChangeCode.length !== 6)
                  }
                >
                  {emailChangeSent
                    ? t('settings.account.confirm_email_change')
                    : t('settings.account.send_change_code')}
                </button>
                <button className="set-btn" onClick={cancelEmailChange} disabled={savingEmail}>
                  {t('settings.common.cancel')}
                </button>
                {emailChangeError && (
                  <span style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>
                    {emailChangeError}
                  </span>
                )}
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value set-mono">{user?.email ?? '—'}</span>
                {user?.email &&
                  (emailVerified ? (
                    <span
                      className="set-mono"
                      style={{ fontSize: 11, color: 'hsl(var(--accent))' }}
                    >
                      ✓ {t('settings.account.verified')}
                    </span>
                  ) : (
                    <button
                      className="set-field__edit"
                      onClick={() => {
                        setVerifyOpen((v) => !v);
                        setVerifyError(null);
                      }}
                    >
                      {t('settings.account.verify')}
                    </button>
                  ))}
                <button
                  className="set-field__edit"
                  onClick={() => {
                    setEmailDraft(user?.email ?? '');
                    setEmailChangeSent(false);
                    setEmailChangeCode('');
                    setEmailChangeError(null);
                  }}
                >
                  {t('settings.common.change')}
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
                  {t('settings.account.send_verify_intro')} <code>{user?.email}</code>
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
                    {t('settings.account.send')}
                  </button>
                  <button className="set-btn" onClick={() => setVerifyOpen(false)}>
                    {t('settings.common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'hsl(var(--ink-3))' }}>
                  {t('settings.account.verify_sent_prefix')} <code>{user?.email}</code>
                  {t('settings.account.verify_sent_suffix')}
                </div>
                <input
                  className="set-input set-input--mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('settings.account.otp_placeholder')}
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
                    {t('settings.account.confirm')}
                  </button>
                  <button className="set-btn" onClick={handleSendVerifyOtp} disabled={verifyBusy}>
                    {t('settings.account.resend')}
                  </button>
                  <button
                    className="set-btn"
                    onClick={() => {
                      setVerifyOpen(false);
                      setVerifySent(false);
                      setVerifyCode('');
                    }}
                  >
                    {t('settings.common.cancel')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <Row
          label={t('settings.account.password')}
          desc={t('settings.account.password_desc')}
          control={
            <button className="set-btn" onClick={() => setPwOpen((v) => !v)}>
              {t('settings.common.change')}
            </button>
          }
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
              placeholder={t('settings.account.current_password')}
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
            />
            <input
              className="set-input"
              type="password"
              placeholder={t('settings.account.new_password')}
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
            />
            {pwError && <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{pwError}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="set-btn set-btn--primary"
                onClick={handleChangePassword}
                disabled={pwBusy || pwCurrent.length === 0 || pwNew.length < 8}
              >
                {t('settings.account.save_password')}
              </button>
              <button className="set-btn" onClick={() => setPwOpen(false)}>
                {t('settings.common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.account.devices')} hint={t('settings.account.devices_hint')} />
        {sessions === null ? (
          <div className="set-row__desc">{t('settings.account.sessions_loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="set-row__desc">{t('settings.account.current_session_only')}</div>
        ) : (
          sessions.map((s) => (
            <div className="set-device" key={s.id}>
              <div className="set-device__glyph">{s.isCurrent ? '▤' : '▢'}</div>
              <div>
                <div className="set-device__name">
                  <b>{s.userAgent ?? t('settings.account.unknown_device')}</b>
                </div>
                <div className="set-device__meta">
                  {s.ipAddress ?? '—'} · {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
              <div className={'set-device__chip' + (s.isCurrent ? '' : ' set-device__chip--idle')}>
                {s.isCurrent
                  ? t('settings.account.this_device')
                  : t('settings.account.other_device')}
              </div>
              <button
                className="set-btn set-btn--ghost"
                onClick={() => (s.isCurrent ? handleLogout() : handleRevokeSession(s.id))}
                disabled={revokingId === s.id}
              >
                {s.isCurrent
                  ? t('settings.account.logout_device')
                  : revokingId === s.id
                    ? t('settings.account.revoking')
                    : t('settings.account.revoke')}
              </button>
            </div>
          ))
        )}
        {revokeError && (
          <div className="set-row__desc" style={{ color: 'hsl(var(--accent))' }}>
            {t('settings.account.revoke_failed', { error: revokeError })}
          </div>
        )}
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.account.sign_out_title')} hint="SIGN OUT" />
        <Row
          label={t('settings.account.sign_out_label')}
          desc={t('settings.account.sign_out_desc')}
          control={
            <button className="set-btn set-btn--primary" onClick={handleLogout}>
              {t('settings.account.sign_out_button')}
            </button>
          }
        />
      </div>

      <div className="set-danger">
        <div className="set-danger__title">{t('settings.account.danger_zone')}</div>
        <Row
          label={t('settings.account.export_all')}
          desc={t('settings.account.export_all_desc')}
          control={
            <button className="set-btn" onClick={handleMarkdownExport} disabled={exportBusy}>
              {exportBusy ? t('settings.account.exporting') : t('settings.account.export_all_btn')}
            </button>
          }
        />
        {exportMessage && <div className="set-row__desc">{exportMessage}</div>}
        {deletion?.pending ? (
          <Row
            label={t('settings.account.delete_pending_title')}
            desc={t('settings.account.delete_pending_desc', {
              daysLeft: deletion.daysLeft ?? 30,
              date: deletion.scheduledAt ? new Date(deletion.scheduledAt).toLocaleDateString() : '',
            })}
            control={
              <button className="set-btn" onClick={handleCancelDeletion} disabled={deletionBusy}>
                {t('settings.account.delete_cancel')}
              </button>
            }
          />
        ) : (
          <Row
            label={t('settings.account.delete_account')}
            desc={t('settings.account.delete_account_desc')}
            control={
              <button
                className="set-btn set-btn--danger"
                onClick={handleRequestDeletion}
                disabled={deletionBusy}
              >
                {t('settings.account.delete_account_btn')}
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

const PLAN_LABEL_KEY: Record<string, string> = {
  free: 'settings.subscription.plans.free_label',
  pro: 'settings.subscription.plans.pro_label',
  studio: 'settings.subscription.plans.studio_label',
};

const PLAN_PRICE: Record<string, string> = {
  free: '¥0',
  pro: '¥58',
  studio: '¥168',
};

function SubscriptionPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id);
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
      if (userId) await refreshFeatureAccess(userId);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

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
  const planName = PLAN_LABEL_KEY[plan] ? t(PLAN_LABEL_KEY[plan]) : plan;
  const renewLine = status?.currentPeriodEnd
    ? `${t('settings.subscription.renew_line', {
        date: new Date(status.currentPeriodEnd).toLocaleDateString(),
      })}${status.cancelAtPeriodEnd ? t('settings.subscription.cancel_at_period_end') : ''}`
    : t('settings.subscription.no_paid_plan');

  if (view === 'plans') {
    return (
      <section className="set-panel" ref={registerRef} id="subscription">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setView('overview')}
        >
          <span>←</span>
          <span>{t('settings.subscription.back')}</span>
        </button>
        <PanelHead
          kicker={t('settings.subscription.plans_kicker')}
          title={t('settings.subscription.plans_title')}
        />
        <div className="set-plans">
          <PlanCard
            kicker={t('settings.subscription.free')}
            name={t('settings.subscription.plans.free_name')}
            price="¥0"
            features={[
              t('settings.subscription.plans.free_feature_1'),
              t('settings.subscription.plans.free_feature_2'),
              t('settings.subscription.plans.free_feature_3'),
              t('settings.subscription.plans.free_feature_4'),
            ]}
            ctaLabel={
              plan === 'free'
                ? t('settings.subscription.current_plan')
                : switching === 'free'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.downgrade')
            }
            current={plan === 'free'}
            onClick={plan === 'free' ? undefined : () => switchPlan('free')}
          />
          <PlanCard
            kicker={
              plan === 'pro'
                ? t('settings.subscription.current_kicker')
                : t('settings.subscription.recommended')
            }
            name="Shadow Pro"
            price="¥58"
            features={[
              t('settings.subscription.plans.pro_feature_1'),
              t('settings.subscription.plans.pro_feature_2'),
              t('settings.subscription.plans.pro_feature_3'),
              t('settings.subscription.plans.pro_feature_4'),
              t('settings.subscription.plans.pro_feature_5'),
            ]}
            ctaLabel={
              plan === 'pro'
                ? t('settings.subscription.current_plan')
                : switching === 'pro'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.upgrade')
            }
            current={plan === 'pro'}
            primary={plan !== 'pro'}
            onClick={plan === 'pro' ? undefined : () => switchPlan('pro')}
          />
          <PlanCard
            kicker={
              plan === 'studio'
                ? t('settings.subscription.current_kicker')
                : t('settings.subscription.professional')
            }
            name="Studio"
            price="¥168"
            features={[
              t('settings.subscription.plans.studio_feature_1'),
              t('settings.subscription.plans.studio_feature_2'),
              t('settings.subscription.plans.studio_feature_3'),
              t('settings.subscription.plans.studio_feature_4'),
            ]}
            ctaLabel={
              plan === 'studio'
                ? t('settings.subscription.current_plan')
                : switching === 'studio'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.upgrade')
            }
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
          <b>DEV</b> · {t('settings.subscription.dev_notice')}
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
          <span>{t('settings.subscription.back')}</span>
        </button>
        <PanelHead
          kicker={t('settings.subscription.invoices_kicker')}
          title={t('settings.subscription.invoices_title')}
        />
        <div className="set-sec">
          <SecHead title={t('settings.subscription.recent')} />
          {!configured && (
            <div className="set-row__desc">{t('settings.subscription.stripe_unconfigured')}</div>
          )}
          {configured && invoices === null && (
            <div className="set-row__desc">{t('settings.subscription.loading')}</div>
          )}
          {configured && invoices && invoices.length === 0 && (
            <div className="set-row__desc">{t('settings.subscription.no_invoices')}</div>
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
                      onClick={() => {
                        if (inv.pdfUrl) void platform.material.openExternal(inv.pdfUrl);
                      }}
                    >
                      {t('settings.subscription.download_pdf')}
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
        kicker={t('settings.subscription.kicker')}
        title={t('settings.subscription.title')}
        sub={
          loading ? (
            t('settings.subscription.loading')
          ) : configured ? (
            <>
              {t('settings.subscription.current_plan_inline')}{' '}
              <em className="set-italic">{planName}</em> · {renewLine}
            </>
          ) : (
            <>{t('settings.subscription.free_plan_inline')}</>
          )
        }
      />

      <div className="set-plan-current">
        <div className="set-plan-current__body">
          <div className="set-plan-current__kicker">
            {plan === 'free'
              ? t('settings.subscription.free')
              : t('settings.subscription.current_kicker')}
          </div>
          <div className="set-plan-current__name">{planName}</div>
          <div className="set-plan-current__meta">
            {PLAN_PRICE[plan] ?? '—'} {t('settings.subscription.per_month')} · {renewLine}
          </div>
        </div>
        <div className="set-plan-current__cta">
          <button
            className="set-btn"
            onClick={isByokOnly() ? undefined : () => setView('plans')}
            disabled={isByokOnly()}
            title={isByokOnly() ? t('settings.subscription.hosted_coming_soon') : undefined}
          >
            {t('settings.subscription.plans_kicker')}
          </button>
          <button className="set-btn" onClick={() => setView('invoices')}>
            {t('settings.subscription.view_invoices')}
          </button>
        </div>
      </div>

      {configured && plan !== 'free' && (
        <div className="set-sec" style={{ marginTop: 28 }}>
          <SecHead title={t('settings.subscription.payment_cancel')} hint="VIA STRIPE PORTAL" />
          <Row
            label={t('settings.subscription.manage_payment')}
            desc={t('settings.subscription.manage_payment_desc')}
            control={
              <button className="set-btn" onClick={() => subscriptionService.openCustomerPortal()}>
                {t('settings.subscription.open_portal')}
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
  const { t } = useTranslation();
  return (
    <div className={'set-plan' + (current ? ' set-plan--current' : '')}>
      <div className="set-plan__kicker">{kicker}</div>
      <div className="set-plan__name">{name}</div>
      <div className="set-plan__price">
        {price}
        <sub>{t('settings.subscription.month_suffix')}</sub>
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
  const { t } = useTranslation();
  return (
    <section className="set-panel" ref={registerRef} id="trash">
      <PanelHead
        kicker={t('settings.trash.kicker')}
        title={t('settings.trash.title')}
        sub={t('settings.trash.sub')}
      />
      <TrashPanel />
    </section>
  );
}

const SHADOW_USAGE_FEATURE_LABEL_KEY: Record<string, string> = {
  'shadow:review': 'settings.shadow_usage.feature_review',
  'shadow:arc': 'settings.shadow_usage.feature_arc',
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
  const { t } = useTranslation();
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
        <SecHead title={t('settings.shadow_usage.title')} hint="USAGE" />
        <p className="set-row__desc" style={{ margin: '-4px 0 8px' }}>
          {t('settings.shadow_usage.desc_a')}
          <b>{t('settings.shadow_usage.local_direct')}</b>
          {t('settings.shadow_usage.desc_b')}
        </p>
        <Seg<'month' | 'all'>
          value={scope}
          options={[
            { value: 'month', label: t('settings.shadow_usage.this_month') },
            { value: 'all', label: t('settings.shadow_usage.all_time') },
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
          {t('settings.shadow_usage.tokens_label')}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
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
            <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.calls.toLocaleString()}</b>{' '}
            {t('settings.shadow_usage.calls')}
          </span>
          <span>
            {t('settings.shadow_usage.input')}{' '}
            <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.inputTokens.toLocaleString()}</b>
          </span>
          <span>
            {t('settings.shadow_usage.output')}{' '}
            <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.outputTokens.toLocaleString()}</b>
          </span>
          {s.total.cachedTokens > 0 && (
            <span>
              {t('settings.shadow_usage.cached')}{' '}
              <b style={{ color: 'hsl(var(--ink-2))' }}>{s.total.cachedTokens.toLocaleString()}</b>
            </span>
          )}
        </div>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SecHead title={t('settings.shadow_usage.by_feature')} hint="BY FEATURE" />
        {s.byFeature.length === 0 ? (
          <p className="set-row__desc" style={{ margin: '4px 0 0' }}>
            {t('settings.shadow_usage.empty')}
          </p>
        ) : (
          s.byFeature.map((f) => (
            <Row
              key={f.feature}
              label={
                SHADOW_USAGE_FEATURE_LABEL_KEY[f.feature]
                  ? t(SHADOW_USAGE_FEATURE_LABEL_KEY[f.feature])
                  : f.feature
              }
              desc={t('settings.shadow_usage.calls_count', {
                count: f.calls.toLocaleString(),
              })}
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
  const { t } = useTranslation();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);

  const themes: { value: ThemeMode; name: string; kind: string; tp: string }[] = [
    { value: 'light', name: t('settings.appearance.light'), kind: 'LIGHT', tp: 'tp--light' },
    { value: 'dark', name: t('settings.appearance.dark'), kind: 'DARK', tp: 'tp--dark' },
    { value: 'system', name: t('settings.appearance.system'), kind: 'SYSTEM', tp: 'tp--system' },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="appearance">
      <PanelHead
        kicker={t('settings.appearance.kicker')}
        title={t('settings.appearance.title')}
        sub={t('settings.appearance.sub')}
      />

      <div className="set-sec">
        <SecHead title={t('settings.appearance.theme')} hint="THEME" />
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

function formatFontFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EditorFontControl() {
  const { t, i18n } = useTranslation();
  const editorFontSource = useSettingsStore((state) => state.editorFontSource);
  const setEditorFontSource = useSettingsStore((state) => state.setEditorFontSource);
  const editorSystemFontFamily = useSettingsStore((state) => state.editorSystemFontFamily);
  const setEditorSystemFontFamily = useSettingsStore(
    (state) => state.setEditorSystemFontFamily,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [systemFamilyDraft, setSystemFamilyDraft] = useState(editorSystemFontFamily);
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [loadingSystemFonts, setLoadingSystemFonts] = useState(true);
  const [systemFontsUnavailable, setSystemFontsUnavailable] = useState(false);
  const [importedFont, setImportedFont] = useState<ImportedProseFontMetadata | null>(null);
  const [loadingImportedFont, setLoadingImportedFont] = useState(true);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontMessage, setFontMessage] = useState<{
    tone: 'error' | 'success';
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getImportedProseFontMetadata()
      .then((metadata) => {
        if (!cancelled) setImportedFont(metadata);
      })
      .catch(() => {
        if (!cancelled) {
          setFontMessage({ tone: 'error', text: t('settings.editor.font_error_storage') });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingImportedFont(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void platform.typography
      .listSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch(() => {
        if (!cancelled) setSystemFontsUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingSystemFonts(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectKnownSystemFont = useCallback(
    (family: string) => {
      if (!family) return;
      setSystemFamilyDraft(family);
      setEditorSystemFontFamily(family);
      setEditorFontSource('system-custom');
      setFontMessage(null);
    },
    [setEditorFontSource, setEditorSystemFontFamily],
  );

  const messageForImportError = useCallback(
    (error: unknown): string => {
      if (error instanceof ProseFontImportError) {
        switch (error.code) {
          case 'empty':
            return t('settings.editor.font_error_empty');
          case 'unsupported-format':
            return t('settings.editor.font_error_format');
          case 'too-large':
            return t('settings.editor.font_error_size');
          case 'invalid-font':
            return t('settings.editor.font_error_invalid');
          case 'storage-unavailable':
            return t('settings.editor.font_error_storage');
        }
      }
      return t('settings.editor.font_error_unknown');
    },
    [t],
  );

  const applySystemFont = useCallback(() => {
    const family = systemFamilyDraft.trim();
    if (!family) {
      setFontMessage({ tone: 'error', text: t('settings.editor.font_system_required') });
      return;
    }
    setEditorSystemFontFamily(family);
    setEditorFontSource('system-custom');
    setFontMessage({ tone: 'success', text: t('settings.editor.font_system_applied') });
  }, [
    setEditorFontSource,
    setEditorSystemFontFamily,
    systemFamilyDraft,
    t,
  ]);

  const handleFontFile = useCallback(
    async (file: File) => {
      setFontBusy(true);
      setFontMessage(null);
      try {
        const metadata = await importProseFont(file);
        setImportedFont(metadata);
        setEditorFontSource('imported');
        setFontMessage({ tone: 'success', text: t('settings.editor.font_import_done') });
      } catch (error) {
        setFontMessage({ tone: 'error', text: messageForImportError(error) });
      } finally {
        setFontBusy(false);
      }
    },
    [messageForImportError, setEditorFontSource, t],
  );

  const removeImportedFont = useCallback(async () => {
    setFontBusy(true);
    setFontMessage(null);
    try {
      await removeImportedProseFont();
      setImportedFont(null);
      if (useSettingsStore.getState().editorFontSource === 'imported') {
        setEditorFontSource('system-serif');
      }
      setFontMessage({ tone: 'success', text: t('settings.editor.font_remove_done') });
    } catch (error) {
      setFontMessage({ tone: 'error', text: messageForImportError(error) });
    } finally {
      setFontBusy(false);
    }
  }, [messageForImportError, setEditorFontSource, t]);

  const options: {
    source: EditorFontSource;
    label: string;
    detail: string;
    disabled?: boolean;
  }[] = [
    {
      source: 'system-serif',
      label: t('settings.editor.font_system_serif'),
      detail: t('settings.editor.font_system_serif_desc'),
    },
    {
      source: 'system-sans',
      label: t('settings.editor.font_system_sans'),
      detail: t('settings.editor.font_system_sans_desc'),
    },
    {
      source: 'system-mono',
      label: t('settings.editor.font_system_mono'),
      detail: t('settings.editor.font_system_mono_desc'),
    },
    {
      source: 'system-custom',
      label: t('settings.editor.font_system_custom'),
      detail: editorSystemFontFamily || t('settings.editor.font_not_configured'),
      disabled: !editorSystemFontFamily,
    },
    {
      source: 'imported',
      label: t('settings.editor.font_imported'),
      detail: loadingImportedFont
        ? t('settings.editor.font_loading')
        : importedFont?.fileName || t('settings.editor.font_not_imported'),
      disabled: loadingImportedFont || !importedFont,
    },
  ];

  return (
    <div className="set-font-control">
      <div
        className="set-font-options"
        role="radiogroup"
        aria-label={t('settings.editor.font_source')}
      >
        {options.map((option) => (
          <button
            key={option.source}
            type="button"
            role="radio"
            aria-checked={editorFontSource === option.source}
            className={
              'set-font-option' +
              (editorFontSource === option.source ? ' set-font-option--active' : '')
            }
            disabled={option.disabled || fontBusy}
            onClick={() => setEditorFontSource(option.source)}
          >
            <span className="set-font-option__name">{option.label}</span>
            <span className="set-font-option__detail">{option.detail}</span>
          </button>
        ))}
      </div>

      <div className="set-font-tools">
        <div className="set-font-tool">
          <div className="set-font-tool__copy">
            <span className="set-font-tool__title">
              {t('settings.editor.font_system_title')}
            </span>
            <span className="set-font-tool__desc">
              {t('settings.editor.font_system_help')}{' '}
              {loadingSystemFonts
                ? t('settings.editor.font_system_loading')
                : systemFontsUnavailable
                  ? t('settings.editor.font_system_unavailable')
                  : t('settings.editor.font_system_loaded', { count: systemFonts.length })}
            </span>
          </div>
          <div className="set-font-tool__actions">
            <select
              className="set-input set-font-tool__select"
              aria-label={t('settings.editor.font_system_placeholder')}
              value={
                systemFonts.some((font) => font.family === editorSystemFontFamily)
                  ? editorSystemFontFamily
                  : ''
              }
              disabled={loadingSystemFonts || systemFontsUnavailable || systemFonts.length === 0}
              onChange={(event) => selectKnownSystemFont(event.target.value)}
            >
              <option value="">
                {loadingSystemFonts
                  ? t('settings.editor.font_system_loading')
                  : t('settings.editor.font_system_placeholder')}
              </option>
              {systemFonts.map((font) => {
                const localizedAlias = i18n.resolvedLanguage?.startsWith('zh')
                  ? font.aliases.find((alias) => /[\u3400-\u9fff]/u.test(alias))
                  : undefined;
                return (
                  <option
                    key={font.family}
                    value={font.family}
                  >
                    {localizedAlias ? `${localizedAlias} — ${font.family}` : font.family}
                  </option>
                );
              })}
            </select>
          </div>
          <details className="set-font-tool__manual">
            <summary>{t('settings.editor.font_system_manual')}</summary>
            <div className="set-font-tool__manual-actions">
              <input
                className="set-input set-font-tool__input"
                value={systemFamilyDraft}
                maxLength={128}
                placeholder={t('settings.editor.font_system_manual_placeholder')}
                aria-label={t('settings.editor.font_system_manual_placeholder')}
                onChange={(event) => setSystemFamilyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applySystemFont();
                }}
              />
              <button
                type="button"
                className="set-btn"
                disabled={fontBusy}
                onClick={applySystemFont}
              >
                {t('settings.editor.font_use')}
              </button>
            </div>
          </details>
        </div>

        <div className="set-font-tool">
          <div className="set-font-tool__copy">
            <span className="set-font-tool__title">
              {t('settings.editor.font_import_title')}
            </span>
            <span className="set-font-tool__desc">
              {importedFont
                ? `${importedFont.fileName} · ${formatFontFileSize(importedFont.byteLength)}`
                : t('settings.editor.font_import_help')}
            </span>
          </div>
          <div className="set-font-tool__actions">
            <button
              type="button"
              className="set-btn"
              disabled={fontBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {fontBusy
                ? t('settings.editor.font_importing')
                : importedFont
                  ? t('settings.editor.font_replace')
                  : t('settings.editor.font_import')}
            </button>
            {importedFont && (
              <button
                type="button"
                className="set-btn set-btn--ghost"
                disabled={fontBusy}
                onClick={() => void removeImportedFont()}
              >
                {t('settings.editor.font_remove')}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORTED_PROSE_FONT_ACCEPT}
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFontFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {fontMessage && (
        <div
          className={`set-font-message set-font-message--${fontMessage.tone}`}
          role={fontMessage.tone === 'error' ? 'alert' : 'status'}
        >
          {fontMessage.text}
        </div>
      )}
    </div>
  );
}

function EditorPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
  const {
    bodyFontSize,
    setBodyFontSize,
    lineHeight,
    setLineHeight,
    paragraphIndent,
    setParagraphIndent,
    editorIndentStep,
    setEditorIndentStep,
    paragraphSpacing,
    setParagraphSpacing,
    maxLineWidth,
    setMaxLineWidth,
    resetEditorStyle,
    typewriterMode,
    setTypewriterMode,
    typewriterPosition,
    setTypewriterPosition,
    caretColor,
    setCaretColor,
    autosave,
    setAutosave,
    autoElementLinkEnabled,
    setAutoElementLinkEnabled,
  } = useSettingsStore();

  return (
    <section className="set-panel" ref={registerRef} id="editor">
      <PanelHead
        kicker={t('settings.editor.kicker')}
        title={t('settings.editor.title')}
        sub={t('settings.editor.sub')}
      />

      <div className="set-sec">
        <SecHead title={t('settings.editor.preview')} hint="PREVIEW" />
        {/* Live sample — reads the same --editor-* CSS variables the real editor
            does (set by applyEditorPreferences), so 字号 / 行距 / 段间距 / 段首缩进
            and the Tab 缩进 width all update here as the controls below change. */}
        {/* The box's own width tracks 纸张宽度 (--editor-max-width), capped to the
            settings column, so narrowing the page narrows the preview too. */}
        <div className="set-preview" aria-hidden="true">
          <p>{t('settings.editor.preview_p1')}</p>
          <p>{t('settings.editor.preview_p2')}</p>
          <p>{t('settings.editor.preview_p3')}</p>
          <p>{t('settings.editor.preview_p4')}</p>
          <p data-indent="1">{t('settings.editor.preview_p5')}</p>
          <p>{t('settings.editor.preview_p6')}</p>
        </div>
      </div>

      <div className="set-sec">
        <SecHead
          title={t('settings.editor.typesetting')}
          hint="TYPESETTING"
          action={
            <button type="button" className="set-btn set-btn--ghost" onClick={resetEditorStyle}>
              {t('settings.editor.reset_style')}
            </button>
          }
        />
        <Row
          label={t('settings.editor.font_source')}
          desc={t('settings.editor.font_scope_desc')}
          control={<EditorFontControl />}
          stack
        />
        <Row
          label={t('settings.editor.font_size')}
          desc={t('settings.editor.font_size_desc')}
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
          label={t('settings.editor.line_height')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={1.0}
                max={2.0}
                step={0.02}
                value={lineHeight}
                onChange={(e) => setLineHeight(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{lineHeight.toFixed(2)}</span>
            </div>
          }
        />
        <Row
          label={t('settings.editor.indent')}
          desc={t('settings.editor.indent_desc')}
          control={
            <Seg<ParagraphIndent>
              value={paragraphIndent}
              options={[
                { value: 'none', label: t('settings.editor.indent_none') },
                { value: 'one', label: t('settings.editor.indent_one') },
                { value: 'two', label: t('settings.editor.indent_two') },
              ]}
              onChange={setParagraphIndent}
            />
          }
        />
        <Row
          label={t('settings.editor.tab_indent')}
          desc={t('settings.editor.tab_indent_desc')}
          control={
            <Seg<string>
              value={String(editorIndentStep)}
              options={['1', '2', '3', '4'].map((v) => ({
                value: v,
                label: t('settings.editor.chars_count', { count: v }),
              }))}
              onChange={(v) => setEditorIndentStep(Number(v))}
            />
          }
        />
        <Row
          label={t('settings.editor.paragraph_spacing')}
          desc={t('settings.editor.paragraph_spacing_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={0}
                max={2.5}
                step={0.05}
                value={paragraphSpacing}
                onChange={(e) => setParagraphSpacing(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{paragraphSpacing.toFixed(2)} em</span>
            </div>
          }
        />
        <Row
          label={t('settings.editor.page_width')}
          desc={t('settings.editor.page_width_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={480}
                max={1280}
                step={10}
                value={maxLineWidth}
                onChange={(e) => setMaxLineWidth(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{maxLineWidth} px</span>
            </div>
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.editor.flow')} hint="FLOW" />
        <Row
          label={t('settings.editor.typewriter_mode')}
          desc={t('settings.editor.typewriter_mode_desc')}
          control={<Toggle on={typewriterMode} onChange={setTypewriterMode} />}
        />
        <Row
          label={t('settings.editor.typewriter_position')}
          desc={t('settings.editor.typewriter_position_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={TYPEWRITER_POSITION_MIN}
                max={TYPEWRITER_POSITION_MAX}
                step={1}
                value={typewriterPosition}
                disabled={!typewriterMode}
                aria-label={t('settings.editor.typewriter_position')}
                onChange={(event) => setTypewriterPosition(Number(event.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{typewriterPosition}%</span>
            </div>
          }
        />
        <Row
          label={t('settings.editor.caret_color')}
          desc={t('settings.editor.caret_color_desc')}
          control={
            <div className="set-color-picker">
              <input
                className="set-color-picker__input"
                type="color"
                value={caretColor}
                aria-label={t('settings.editor.caret_color')}
                onChange={(event) => setCaretColor(event.target.value)}
              />
              <span className="set-color-picker__value">{caretColor.toUpperCase()}</span>
            </div>
          }
        />
        <Row
          label={t('settings.editor.auto_element_link')}
          desc={t('settings.editor.auto_element_link_desc')}
          control={<Toggle on={autoElementLinkEnabled} onChange={setAutoElementLinkEnabled} />}
        />
        <Row
          label={t('settings.editor.autosave')}
          desc={
            <>
              {t('settings.editor.autosave_desc_a')} <code>3 {t('settings.editor.seconds')}</code>
              {t('settings.editor.autosave_desc_b')}
            </>
          }
          control={<Toggle on={autosave} onChange={setAutosave} />}
        />
      </div>
    </section>
  );
}

function LanguagePanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
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

  const manuscriptLocales: { code: LocaleCode; name: string; native: string }[] = [
    {
      code: 'zh-CN',
      name: t('settings.language.locales.zhCN'),
      native: t('settings.language.locales.default'),
    },
    {
      code: 'zh-TW',
      name: t('settings.language.locales.zhTW'),
      native: t('settings.language.locales.traditional'),
    },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'ja', name: '日本語', native: '日本語' },
    { code: 'ko', name: '한국어', native: '한국어' },
    { code: 'fr', name: 'Français', native: t('settings.language.locales.beta') },
  ];
  const normalizedUiLocale = uiLocale.startsWith('zh') ? 'zh-CN' : 'en';

  return (
    <section className="set-panel" ref={registerRef} id="language">
      <PanelHead
        kicker={t('settings.language.kicker')}
        title={t('settings.language.title')}
        sub={t('settings.language.sub')}
      />

      <div className="set-sec">
        <SecHead title={t('settings.language.ui_locale')} hint="UI LOCALE" />
        <div className="set-locales">
          {UI_LOCALE_OPTIONS.map((l) => (
            <button
              key={l.code}
              className={
                'set-locale' + (normalizedUiLocale === l.code ? ' set-locale--active' : '')
              }
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
        <SecHead title={t('settings.language.manuscript')} hint="MANUSCRIPT" />
        <Row
          label={t('settings.language.manuscript_default')}
          desc={t('settings.language.manuscript_default_desc')}
          control={
            <select
              className="set-input"
              style={{ minWidth: 220 }}
              value={manuscriptLocale}
              onChange={(e) => setManuscriptLocale(e.target.value as LocaleCode)}
            >
              {manuscriptLocales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} · {l.code}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label={t('settings.language.spellcheck')}
          desc={t('settings.language.spellcheck_desc')}
          control={<Toggle on={spellcheck} onChange={setSpellcheck} />}
        />
        <Row
          label={t('settings.language.date_format')}
          desc={t('settings.language.date_format_desc')}
          control={
            <Seg<DateFormat>
              value={dateFormat}
              options={[
                { value: 'cjk', label: t('settings.language.date_cjk') },
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

/** Credential status for the installed General Agent transport. */
function AgentAuthRow({ auth }: { auth: AgentAuth }) {
  const { t } = useTranslation();
  const api = generalAgentTransport;
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
  const usesSharedDeepSeekKey = api.capability.kind === 'local';

  const refresh = useCallback(() => {
    if (!api.capability.available) return;
    void api
      .authStatus()
      .then((result) => {
        setStatus(
          result.ok
            ? result.value
            : { byokConnected: false, apiKeyConnected: false, hostedAvailable: false },
        );
      })
      .catch(() =>
        setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
      );
  }, [api]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    const read = usesSharedDeepSeekKey
      ? byokKeychain.get('deepseek')
      : agentApiKeychain.get();
    void read.then((v) => {
      if (!cancelled) setKeyStored(v);
    });
    return () => {
      cancelled = true;
    };
  }, [usesSharedDeepSeekKey]);

  if (!api.capability.available) {
    return (
      <div className="set-sec">
        <SecHead title={t('settings.agent.unavailableTitle')} hint="TAURI · UNSUPPORTED" />
        <p className="set-row__desc">{t('settings.agent.unavailableReason')}</p>
        <p className="set-row__desc">{t('settings.agent.unavailableFuture')}</p>
      </div>
    );
  }

  const connect = async () => {
    setErr(null);
    const result = await api.authPrepare();
    if (!result.ok) {
      setErr(result.error);
      return;
    }
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
    const result = await api.authLogout();
    if (!result.ok) {
      setErr(result.error);
      return;
    }
    refresh();
    events.emit('agent:auth-changed');
  };

  const saveKey = async () => {
    const v = keyDraft.trim();
    if (!v) {
      if (usesSharedDeepSeekKey) await byokKeychain.clear('deepseek');
      else await agentApiKeychain.clear();
      setKeyStored(null);
    } else {
      if (usesSharedDeepSeekKey) await byokKeychain.set('deepseek', v);
      else await agentApiKeychain.set(v);
      setKeyStored(v);
    }
    setKeyDraft('');
    setKeyEditing(false);
    refresh();
    events.emit('agent:auth-changed');
  };
  const clearKey = async () => {
    if (usesSharedDeepSeekKey) await byokKeychain.clear('deepseek');
    else await agentApiKeychain.clear();
    setKeyStored(null);
    refresh();
    events.emit('agent:auth-changed');
  };

  if (auth === 'hosted') {
    const ok = !!status?.hostedAvailable;
    return (
      <div className="set-sec">
        <SecHead title={t('settings.agentAuth.statusTitle')} hint="HOSTED" />
        <Row
          label={ok ? t('settings.agentAuth.hostedReady') : t('settings.agentAuth.hostedSignedOut')}
          desc={
            ok
              ? t('settings.agentAuth.hostedReadyDesc')
              : t('settings.agentAuth.hostedSignedOutDesc')
          }
          control={
            <span
              className="set-mono"
              style={{ color: ok ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))' }}
            >
              {ok
                ? t('settings.agentAuth.hostedAvailable')
                : t('settings.agentAuth.hostedUnavailable')}
            </span>
          }
        />
      </div>
    );
  }

  if (auth === 'apikey' || usesSharedDeepSeekKey) {
    const hasKey = !!keyStored;
    return (
      <div className="set-sec">
        <SecHead
          title={usesSharedDeepSeekKey ? 'DeepSeek API Key' : 'Anthropic API Key'}
          hint="PAY-AS-YOU-GO"
        />
        {keyEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{t('settings.agentAuth.pasteApiKey')}</div>
            <input
              className="set-input set-input--mono"
              style={{ minWidth: 320 }}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={usesSharedDeepSeekKey ? 'sk-...' : 'sk-ant-...'}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="set-btn set-btn--primary" onClick={saveKey}>
                {t('settings.common.save')}
              </button>
              <button
                className="set-btn"
                onClick={() => {
                  setKeyDraft('');
                  setKeyEditing(false);
                }}
              >
                {t('settings.common.cancel')}
              </button>
            </div>
          </div>
        ) : hasKey ? (
          <Row
            label={t('settings.agentAuth.filled')}
            desc={t('settings.agentAuth.apiKeyFilledDesc')}
            control={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code className="set-mono">{maskBYOK(keyStored)}</code>
                <button className="set-btn" onClick={() => setKeyEditing(true)}>
                  {t('settings.common.edit')}
                </button>
                <button className="set-btn set-btn--danger" onClick={clearKey}>
                  {t('settings.common.delete')}
                </button>
              </div>
            }
          />
        ) : (
          <Row
            label={t('settings.agentAuth.notFilled')}
            desc={t('settings.agentAuth.apiKeyEmptyDesc')}
            control={
              <button className="set-btn set-btn--primary" onClick={() => setKeyEditing(true)}>
                {t('settings.agentAuth.enterKey')}
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
      <SecHead title={t('settings.agentAuth.oauthTitle')} hint="BYOK" />
      {connected ? (
        <Row
          label={t('settings.agentAuth.connected')}
          desc={t('settings.agentAuth.oauthConnectedDesc')}
          control={
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </button>
          }
        />
      ) : !awaitingCode ? (
        <Row
          label={t('settings.agentAuth.notConnected')}
          desc={t('settings.agentAuth.oauthEmptyDesc')}
          control={
            <button className="set-btn set-btn--primary" onClick={connect}>
              {t('settings.agentAuth.connectClaude')}
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{t('settings.agentAuth.pasteCode')}</div>
          <input
            className="set-input set-input--mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="authorization code"
            autoFocus
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="set-btn set-btn--primary" disabled={busy} onClick={submit}>
              {busy ? t('settings.agentAuth.verifying') : t('settings.agentAuth.submit')}
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setAwaitingCode(false);
                setErr(null);
              }}
            >
              {t('settings.common.cancel')}
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
  credentialsActive,
  provider,
  logoClass,
  logoText,
  name,
  desc,
}: {
  credentialsActive: boolean;
  provider: BYOKProvider;
  logoClass: string;
  logoText: string;
  name: string;
  desc: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [stored, setStored] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from the OS keychain on mount. The renderer never holds the
  // secret in any persisted store — only this local state for masking.
  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void byokKeychain
      .get(provider)
      .then((value) => {
        if (!cancelled) setStored(value);
      })
      .catch(() => {
        if (!cancelled) setStored(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive, provider]);

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
        setTestMsg(res.data?.message ?? t('settings.byokProvider.invalidKey'));
      }
    } catch {
      setTestState('fail');
      setTestMsg(t('settings.byokProvider.requestFailed'));
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
    <div
      className={
        'set-provider' + (connected ? ' set-provider--connected' : ' set-provider--disconnected')
      }
    >
      <div className="set-provider__head">
        <div className={`set-provider__logo ${logoClass}`}>{logoText}</div>
        <div className="set-provider__main">
          <div className="set-provider__name">
            <b>{name}</b>
            <em className={connected ? 'is-byok' : ''}>
              {connected
                ? t('settings.byokProvider.ownKey')
                : t('settings.byokProvider.notConnected')}
            </em>
          </div>
          <div className="set-provider__desc">{desc}</div>
        </div>
        <div
          className={
            'set-provider__status ' +
            (connected ? 'set-provider__status--live' : 'set-provider__status--off')
          }
        >
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
                  placeholder={t('settings.byokProvider.keyPlaceholder')}
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
              {t('settings.common.save')}
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </button>
          </>
        ) : connected ? (
          <>
            <button className="set-btn" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing'
                ? t('settings.byokProvider.testing')
                : t('settings.common.test_connection')}
            </button>
            {testState === 'ok' && (
              <span className="set-mono" style={{ color: '#2e7d52' }}>
                {t('settings.byokProvider.available')}
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
              {t('settings.byokProvider.editKey')}
            </button>
            {copilotAiMode === 'byok' &&
              (isActive ? (
                <span className="set-mono" style={{ color: '#4D6BFE', fontWeight: 600 }}>
                  {t('settings.byokProvider.currentByok')}
                </span>
              ) : (
                <button className="set-btn" onClick={() => setCopilotByokProvider(provider)}>
                  {t('settings.byokProvider.setCurrent')}
                </button>
              ))}
            <span style={{ flex: 1 }} />
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              {t('settings.common.disconnect')}
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
            {t('settings.common.connect')}
          </button>
        )}
      </div>
    </div>
  );
}

// Shadow BYOK shares Copilot's DeepSeek keychain entry (byok.deepseek) — it has no
// key entry of its own. This makes that borrow VISIBLE: shows connected/未连接 and
// jumps to the Copilot panel (where the key is actually entered) so the user isn't
// left with a silent no-key BYOK that only errors at run time.
function ShadowDeepseekKeyStatus({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const connected = useByokConnected('deepseek', credentialsActive);
  const jumpToCopilot = () =>
    document.getElementById('copilot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (connected === null) return null;
  return (
    <Row
      label={t('settings.shadow.deepseekKey')}
      desc={t('settings.shadow.deepseekKeyDesc')}
      control={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="set-mono"
            style={{ fontSize: 12, color: connected ? '#2e7d52' : 'hsl(38 80% 42%)' }}
          >
            {connected ? t('settings.shadow.keyConnected') : t('settings.shadow.keyNotConnected')}
          </span>
          <button className="set-btn" onClick={jumpToCopilot}>
            {t('settings.shadow.goToCopilot')}
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
function ShadowPanel({
  credentialsActive,
  registerRef,
}: {
  credentialsActive: boolean;
  registerRef: RegisterRef;
}) {
  const { t } = useTranslation();
  const shadowByokModel = useSettingsStore((s) => s.shadowByokModel);
  const setShadowByokModel = useSettingsStore((s) => s.setShadowByokModel);

  return (
    <section className="set-panel" ref={registerRef} id="shadow">
      <PanelHead
        kicker={t('settings.shadow.kicker')}
        title={t('settings.shadow.title')}
        sub={
          <>
            {t('settings.shadow.sub')}
            <span className="set-italic"> {t('settings.shadow.keyPrivacy')}</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title={t('settings.ai.byokTitle')} hint="BYOK ONLY" />
        <p className="set-row__desc">{t('settings.ai.preAlphaByokOnly')}</p>
        <ShadowDeepseekKeyStatus credentialsActive={credentialsActive} />
        <Row
          label={t('settings.shadow.deepseekModel')}
          desc={t('settings.shadow.deepseekModelDesc')}
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

      <ShadowUsageSection />
    </section>
  );
}

const COPILOT_DEBOUNCE_MIN_SEC = 1;
const COPILOT_DEBOUNCE_MAX_SEC = 60;
const COPILOT_SECTION_SIZE_MIN = 3;
const COPILOT_SECTION_SIZE_MAX = 30;

function clampDebounceSec(sec: number): number {
  return Math.min(COPILOT_DEBOUNCE_MAX_SEC, Math.max(COPILOT_DEBOUNCE_MIN_SEC, Math.round(sec)));
}

/**
 * Per-task config row. Shows the task's name, a wired/not-wired indicator,
 * its enable toggle, and (if wired) a debounce slider. The slider value
 * defaults to the capability's `defaultDebounceMs` until the user overrides.
 */
function CopilotTaskRow({
  taskId,
  label,
  desc,
}: {
  taskId: CopilotTaskId;
  label: string;
  desc: string;
}) {
  const { t } = useTranslation();
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
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{label}</strong>
            {!wired && (
              <span
                style={{
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'hsl(var(--rule) / 0.3)',
                }}
              >
                {t('settings.copilot.notLive')}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--ink-2))', marginTop: 4 }}>{desc}</div>
        </div>
        <Toggle on={enabled} onChange={(on) => setEnabled(taskId, on)} />
      </div>

      {wired && enabled && (
        <div style={{ marginTop: 12, paddingLeft: 4 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              fontSize: 12,
              color: 'hsl(var(--ink-3))',
              marginBottom: 4,
            }}
          >
            <span>{t('settings.copilot.triggerRhythm')}</span>
            <span>
              {t('settings.copilot.afterStopPrefix')}
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  margin: '0 4px',
                  color: 'hsl(var(--ink-1))',
                }}
              >
                {effectiveSec}s
              </span>
              {t('settings.copilot.afterStopSuffix')}
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
                  title={t('settings.copilot.resetTaskDefaultTitle')}
                >
                  {t('settings.copilot.resetDefault')}
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

// Known models per BYOK provider — drives the Copilot model dropdown so the user
// picks instead of hand-typing a model id. Only ids the codebase already blesses
// (deepseek v4 flash/pro, the Agent catalog's pinned Claude ids, the GoogleModel
// union); openai has no sanctioned catalog here, so it falls back to 默认/自定义.
// The model is still resolved server-side (synced via preferences) — this is a
// UX layer over the same copilotByokModel value, NOT new routing.
const COPILOT_BYOK_MODELS: Record<BYOKProvider, { value: string; label: string }[]> = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek Pro' },
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
function useByokConnected(provider: BYOKProvider, credentialsActive: boolean): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    const read = () => {
      void byokKeychain
        .get(provider)
        .then((k) => {
          if (!cancelled) setConnected(!!k);
        })
        .catch(() => {
          if (!cancelled) setConnected(false);
        });
    };
    read();
    events.on('byok:keys-changed', read);
    return () => {
      cancelled = true;
      events.off('byok:keys-changed', read);
    };
  }, [credentialsActive, provider]);
  return connected;
}

// Sentinel select value for the "custom model id" escape hatch.
const BYOK_MODEL_CUSTOM = '__custom__';

// Copilot BYOK model picker: a dropdown of known models for the active provider
// (+ provider-default + 自定义…), replacing the old hand-typed model-id input.
function CopilotByokModelPicker() {
  const { t } = useTranslation();
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
        <option value="">{t('settings.copilot.providerDefault')}</option>
        {known.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
        <option value={BYOK_MODEL_CUSTOM}>{t('settings.copilot.customModel')}</option>
      </select>
      {showCustom && (
        <input
          className="set-input set-input--mono"
          style={{ minWidth: 240 }}
          placeholder={t('settings.copilot.modelIdPlaceholder')}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      )}
    </div>
  );
}

// Warns when the active provider has no key. Pre-Alpha never falls back to hosted.
function CopilotByokWarning({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const provider = useSettingsStore((s) => s.copilotByokProvider);
  const connected = useByokConnected(provider, credentialsActive);
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
      {t('settings.copilot.byokWarningPrefix', { provider: BYOK_PROVIDER_LABEL[provider] })}
      <b>{t('settings.copilot.byokWarningStrong')}</b>
      {t('settings.copilot.byokWarningSuffix')}
    </div>
  );
}

function CopilotPanel({
  credentialsActive,
  registerRef,
}: {
  credentialsActive: boolean;
  registerRef: RegisterRef;
}) {
  const { t } = useTranslation();
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
        kicker={t('settings.copilot.kicker')}
        title={t('settings.copilot.title')}
        sub={
          <>
            {t('settings.copilot.sub')}
            <span className="set-italic"> {t('settings.copilot.keyPrivacy')}</span>
          </>
        }
      />

      <>
        <div className="set-sec">
          <SecHead title={t('settings.ai.byokTitle')} hint="BYOK ONLY · 4 PROVIDERS" />
          <p className="set-row__desc">{t('settings.ai.preAlphaByokOnly')}</p>
          <CopilotByokWarning credentialsActive={credentialsActive} />
          <ProviderRow
            credentialsActive={credentialsActive}
            provider="deepseek"
            logoClass="set-provider__logo--deepseek"
            logoText="D"
            name="DeepSeek"
            desc={t('settings.copilot.providers.deepseek')}
          />
          <ProviderRow
            credentialsActive={credentialsActive}
            provider="anthropic"
            logoClass="set-provider__logo--anthropic"
            logoText="A"
            name="Anthropic"
            desc={t('settings.copilot.providers.anthropic')}
          />
          <ProviderRow
            credentialsActive={credentialsActive}
            provider="openai"
            logoClass="set-provider__logo--openai"
            logoText="O"
            name="OpenAI"
            desc={t('settings.copilot.providers.openai')}
          />
          <ProviderRow
            credentialsActive={credentialsActive}
            provider="google"
            logoClass="set-provider__logo--google"
            logoText="G"
            name="Google"
            desc={t('settings.copilot.providers.google')}
          />
        </div>

        <div className="set-sec">
          <SecHead title={t('settings.ai.modelTitle')} hint="MODEL" />
          <Row
            label={t('settings.copilot.byokModel')}
            desc={t('settings.copilot.byokModelDesc')}
            control={<CopilotByokModelPicker />}
          />
        </div>
      </>

      <div className="set-sec">
        <SecHead title={t('settings.copilot.switchesTitle')} hint="ENABLE" />
        <Row
          label={t('settings.copilot.autoTrigger')}
          desc={t('settings.copilot.autoTriggerDesc')}
          control={<Toggle on={autoTrigger} onChange={setAutoTrigger} />}
        />
        <Row
          label={t('settings.copilot.enableInDrift')}
          desc={t('settings.copilot.enableInDriftDesc')}
          control={<Toggle on={copilotInDrift} onChange={setCopilotInDrift} />}
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.copilot.summaryTitle')} hint="SUMMARY" />
        <Row
          label={t('settings.copilot.generateSummaries')}
          desc={t('settings.copilot.generateSummariesDesc')}
          control={<Toggle on={generateSummaries} onChange={setGenerateSummaries} />}
        />
        {generateSummaries && (
          <Row
            label={t('settings.copilot.summaryThreshold')}
            desc={t('settings.copilot.summaryThresholdDesc', { count: sectionSize })}
            stack
            control={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  minWidth: 220,
                }}
              >
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
                  {t('settings.copilot.blocks', { count: sectionSize })}
                </span>
              </div>
            }
          />
        )}
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.copilot.tasksTitle')} hint="TASKS" />
        <p className="set-row__desc" style={{ margin: '-4px 0 0' }}>
          {t('settings.copilot.tasksDesc')}
        </p>
        {COPILOT_TASKS.map((task) => (
          <CopilotTaskRow
            key={task.id}
            taskId={task.id}
            label={t(`settings.copilot.tasks.${task.id}.label`, { defaultValue: task.label })}
            desc={t(`settings.copilot.tasks.${task.id}.desc`, { defaultValue: task.desc })}
          />
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

// Author-facing management of the agent's saved memories (preferences / vetoes /
// directives — see domain/agent-memory). The fuller surface vs the agt-menu mini
// list: view + approve a pending memory + delete. Open-gated load like the usage
// section; all setState in async callbacks (clear of set-state-in-effect).
function AgentMemorySection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [draftKind, setDraftKind] = useState<AgentMemoryKind>('preference');
  const [draftBody, setDraftBody] = useState('');

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    void listLiveMemories(projectId)
      .then((rows) => {
        if (!cancelled) setMemories(rows);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const reload = () => {
    if (!projectId) return;
    void listLiveMemories(projectId)
      .then(setMemories)
      .catch(() => setMemories([]));
  };

  // Hide dismissed (retired/superseded); show active + pending.
  const visible = memories.filter((m) => m.status !== 'dismissed');

  const kindLabel = (k: AgentMemory['kind']) =>
    k === 'veto'
      ? t('settings.agentMemory.kind.veto')
      : k === 'directive'
        ? t('settings.agentMemory.kind.directive')
        : t('settings.agentMemory.kind.preference');

  const approve = (id: string) => {
    if (!projectId) return;
    void approvePendingMemory(projectId, id).then(reload);
  };
  const remove = (id: string) => {
    if (!projectId) return;
    if (!window.confirm(t('settings.agentMemory.deleteConfirm'))) return;
    void softDeleteMemory(projectId, id).then(reload);
  };
  // Manual add — author-authored, active immediately (it's the author's own).
  const add = () => {
    const body = draftBody.trim();
    if (!body || !projectId) return;
    void createMemory(projectId, {
      kind: draftKind,
      body,
      source: 'author',
      status: 'active',
    }).then(() => {
      setDraftBody('');
      reload();
    });
  };

  return (
    <div className="set-sec">
      <SecHead title={t('settings.agentMemory.title')} hint="MEMORY" />
      <p className="set-panel__sub" style={{ marginTop: -2, marginBottom: 12 }}>
        {t('settings.agentMemory.desc')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select
          className="set-input"
          style={{ flexShrink: 0, width: 84 }}
          value={draftKind}
          onChange={(e) => setDraftKind(e.target.value as AgentMemoryKind)}
        >
          <option value="preference">{t('settings.agentMemory.kind.preference')}</option>
          <option value="directive">{t('settings.agentMemory.kind.directive')}</option>
          <option value="veto">{t('settings.agentMemory.kind.veto')}</option>
        </select>
        <input
          className="set-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={t('settings.agentMemory.placeholder')}
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button
          className="set-btn set-btn--primary"
          style={{ flexShrink: 0 }}
          disabled={!draftBody.trim()}
          onClick={add}
        >
          {t('settings.agentMemory.add')}
        </button>
      </div>
      {visible.length === 0 ? (
        <div
          style={{
            border: '1px dashed hsl(var(--rule))',
            borderRadius: 5,
            padding: '16px',
            color: 'hsl(var(--ink-4))',
            fontSize: 12.5,
          }}
        >
          {t('settings.agentMemory.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {visible.map((m) => {
            const pending = m.status === 'pending';
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 5,
                  background: 'hsl(var(--surface))',
                  padding: '10px 12px',
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.04em',
                    padding: '2px 6px',
                    borderRadius: 4,
                    marginTop: 1,
                    color: m.kind === 'veto' ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
                    background:
                      m.kind === 'veto' ? 'hsl(var(--accent) / 0.1)' : 'hsl(var(--ink-1) / 0.07)',
                  }}
                >
                  {kindLabel(m.kind)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'hsl(var(--ink-1))', lineHeight: 1.5 }}>
                    {m.body}
                  </div>
                  {pending && (
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: 'hsl(var(--accent))',
                        marginTop: 4,
                      }}
                    >
                      {t('settings.agentMemory.pending')}
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>
                  {pending && (
                    <button className="set-btn" onClick={() => approve(m.id)}>
                      {t('settings.agentMemory.approve')}
                    </button>
                  )}
                  <button className="set-btn set-btn--danger" onClick={() => remove(m.id)}>
                    {t('settings.common.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentUsageSection({ open }: { open: boolean }) {
  const { t } = useTranslation();
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
  const scopeLabel =
    scope === 'month' ? t('settings.agentUsage.month') : t('settings.agentUsage.all');

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
    if (!window.confirm(t('settings.agentUsage.clearConfirm', { count: live.length }))) return;
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
          fontFamily: 'var(--font-sans)',
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
        label={t('settings.agentUsage.usage')}
        hint="USAGE"
        desc={t('settings.agentUsage.usageDesc')}
      />

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>
          {t('settings.agentUsage.noProjectUsage')}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Seg<'month' | 'all'>
              value={scope}
              options={[
                { value: 'month', label: t('settings.agentUsage.month') },
                { value: 'all', label: t('settings.agentUsage.all') },
              ]}
              onChange={setScope}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {card(
              t('settings.agentUsage.tokenCard', { scope: scopeLabel }),
              fmtUsageTok(totals.input + totals.output),
              `↑${fmtUsageTok(totals.input)} ↓${fmtUsageTok(totals.output)}`,
            )}
            {card(
              t('settings.agentUsage.costCard', { scope: scopeLabel }),
              fmtUsageUsd(totals.cost),
            )}
            {card(
              t('settings.agentUsage.conversationsTurns'),
              `${withUsage.length} / ${totals.turns}`,
            )}
          </div>
        </>
      )}

      <GroupHead
        label={t('settings.agentUsage.history')}
        hint="HISTORY"
        desc={t('settings.agentUsage.historyDesc')}
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
            {t('settings.agentUsage.clearHistory')}
          </button>
        </div>
      )}

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>
          {t('settings.agentUsage.noProjectHistory')}
        </div>
      ) : live.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13, padding: '8px 0' }}>
          {t('settings.agentUsage.noHistory')}
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
                {r.title || t('settings.agentUsage.untitled')}
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
                title={t('settings.agentUsage.deleteConversation')}
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

const AGENT_AUTH_OPTIONS: { value: Exclude<AgentAuth, 'hosted'>; kickerKey: string }[] = [
  { value: 'apikey', kickerKey: 'settings.agent.auth.apikey.kicker' },
];

function AgentPanel({ open, registerRef }: { open: boolean; registerRef: RegisterRef }) {
  const { t } = useTranslation();
  const agentAuth = useSettingsStore((s) => s.agentAuth);
  const setAgentAuth = useSettingsStore((s) => s.setAgentAuth);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentToolSearch = useSettingsStore((s) => s.agentToolSearch);
  const setAgentToolSearch = useSettingsStore((s) => s.setAgentToolSearch);

  if (!generalAgentTransport.capability.available) {
    return (
      <section className="set-panel" ref={registerRef} id="agent">
        <PanelHead
          kicker={t('settings.agent.kicker')}
          title={t('settings.agent.unavailableTitle')}
          sub={t('settings.agent.unavailableReason')}
        />
        <div className="set-sec">
          <SecHead title={t('settings.agent.unavailableStatus')} hint="TAURI · UNSUPPORTED" />
          <p className="set-row__desc">{t('settings.agent.unavailableFuture')}</p>
        </div>
        <AgentMemorySection open={open} />
        <AgentUsageSection open={open} />
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="agent">
      <PanelHead
        kicker={t('settings.agent.kicker')}
        title={t('settings.agent.title')}
        sub={
          <>
            {t('settings.agent.sub')}
            <span className="set-italic"> {t('settings.agent.credentialPrivacy')}</span>
          </>
        }
      />

      <div className="set-sec">
        <SecHead title={t('settings.ai.routing')} hint="YOUR CREDENTIALS" />
        <p className="set-row__desc">{t('settings.ai.preAlphaAgentCredentials')}</p>
        <div className="set-tiers">
          {AGENT_AUTH_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={'set-tier' + (agentAuth === option.value ? ' set-tier--active' : '')}
              onClick={() => setAgentAuth(option.value)}
            >
              <div className="set-tier__kicker">{t(option.kickerKey)}</div>
              <div className="set-tier__name">{t(`settings.agent.auth.${option.value}.name`)}</div>
              <div className="set-tier__desc">{t(`settings.agent.auth.${option.value}.desc`)}</div>
            </button>
          ))}
        </div>
      </div>

      <AgentAuthRow auth={agentAuth} />

      <div className="set-sec">
        <SecHead title={t('settings.ai.modelTitle')} hint="MODEL" />
        <Row
          label={t('settings.agent.chatModel')}
          desc={t('settings.agent.chatModelDesc')}
          control={
            <select
              className="set-input"
              style={{ minWidth: 220 }}
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
            >
              {AGENT_MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {t(`settings.agent.modelOptions.${m.value}.label`, { defaultValue: m.label })}
                </option>
              ))}
            </select>
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.agent.toolSearchTitle')} hint="TOOL SEARCH" />
        <Row
          label={t('settings.agent.toolSearch')}
          desc={t('settings.agent.toolSearchDesc')}
          control={
            <Seg<AgentToolSearch>
              value={agentToolSearch}
              options={AGENT_TOOL_SEARCH_OPTIONS.map((o) => ({
                value: o.value,
                label: t(`settings.agent.toolSearchOptions.${o.value}`, { defaultValue: o.label }),
              }))}
              onChange={setAgentToolSearch}
            />
          }
        />
      </div>

      <AgentMemorySection open={open} />

      <AgentUsageSection open={open} />
    </section>
  );
}

function KeysPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
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
        setError(
          t('settings.keys.conflict', {
            accelerator: formatAccelerator(accelerator),
            action: def ? t(`settings.keys.actions.${def.id}.label`) : conflict[0],
          }),
        );
        return;
      }
      setBinding(recording, accelerator);
      setRecording(null);
      setError(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, bindings, setBinding, t]);

  return (
    <section className="set-panel" ref={registerRef} id="keys">
      <PanelHead
        kicker={t('settings.keys.kicker')}
        title={t('settings.keys.title')}
        sub={t('settings.keys.sub')}
      />

      {error && (
        <div className="set-note" style={{ marginBottom: 14, color: 'hsl(var(--accent))' }}>
          {error}
        </div>
      )}

      <div className="set-keys">
        <div className="set-keys__group-head">
          {t('settings.keys.allActions', { count: SHORTCUT_ACTIONS.length })}
        </div>
        {SHORTCUT_ACTIONS.map((action) => {
          const accel = bindings[action.id];
          const isRecording = recording === action.id;
          return (
            <div className="set-keys__row" key={action.id}>
              <div>
                <div className="set-keys__label">
                  {t(`settings.keys.actions.${action.id}.label`)}
                </div>
                <div className="set-row__desc" style={{ marginTop: 2 }}>
                  {t(`settings.keys.actions.${action.id}.desc`)}
                </div>
              </div>
              <span className="set-keys__cat">
                {isRecording ? t('settings.keys.recording') : ''}
              </span>
              <button
                className="set-keys__combo"
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : action.id);
                }}
                onDoubleClick={() => resetBinding(action.id)}
                style={{ background: 'transparent', border: 0, padding: 0 }}
                title={t('settings.keys.resetOneTitle')}
              >
                {(isRecording ? t('settings.keys.pressNewCombo') : formatAccelerator(accel))
                  .split('+')
                  .map((part, i, arr) => (
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
        label={t('settings.keys.resetAll')}
        desc={t('settings.keys.resetAllDesc')}
        control={
          <button className="set-btn" onClick={resetAll}>
            {t('settings.keys.reset')}
          </button>
        }
      />
    </section>
  );
}

function SyncSummaryRow() {
  const { t } = useTranslation();
  // Live metrics from the sync observer. We don't import the full
  // SyncActivityPanel here — that keeps the overview row light.
  const metrics = useSyncObserver((s) => s.metrics);
  const last = metrics.lastSuccessAt ? new Date(metrics.lastSuccessAt).toLocaleTimeString() : '—';
  const successPct = Math.round(metrics.successRate * 100);
  const latestAttemptFailed =
    metrics.lastFailureAt !== null &&
    (metrics.lastSuccessAt === null || metrics.lastFailureAt > metrics.lastSuccessAt);
  const status =
    metrics.inflight > 0
      ? t('settings.sync.syncing')
      : latestAttemptFailed
        ? t('settings.sync.needs_attention')
        : t('settings.sync.idle');
  return (
    <Row
      label={t('settings.sync.cloud')}
      desc={
        metrics.total === 0 ? (
          t('settings.sync.no_activity')
        ) : (
          <>
            {t('settings.sync.lastSuccess')} <span className="set-italic">{last}</span> ·{' '}
            {t('settings.sync.successRate')} <b>{successPct}%</b>
            {metrics.inflight > 0 ? t('settings.sync.inflight', { count: metrics.inflight }) : ''}
          </>
        )
      }
      control={
        <span
          className="set-mono"
          style={{ color: latestAttemptFailed ? 'hsl(var(--destructive))' : 'hsl(var(--ink-3))' }}
        >
          {status}
        </span>
      }
    />
  );
}

function SyncPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
  const { syncDebugToasts, setSyncDebugToasts } = useSettingsStore();
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
          <span>{t('settings.sync.back_to_sync')}</span>
        </button>
        <PanelHead
          kicker={t('settings.sync.activity_kicker')}
          title={t('settings.sync.activity_title')}
          sub={t('settings.sync.activity_sub')}
        />
        <SyncActivityPanel />
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="sync">
      <PanelHead
        kicker={t('settings.sync.kicker')}
        title={t('settings.sync.title')}
        sub={t('settings.sync.sub')}
      />

      <div className="set-sec">
        <SecHead title={t('settings.sync.cloud_sync')} hint="CLOUD BACKUP" />
        <SyncSummaryRow />
        <Row
          label={t('settings.sync.activity')}
          desc={t('settings.sync.activity_desc')}
          control={
            <button className="set-btn" onClick={() => setActivityOpen(true)}>
              {t('settings.sync.activity_open')}
            </button>
          }
        />
        <Row
          label={t('settings.sync.vault_path')}
          desc={t('settings.sync.local_data_managed')}
          control={
            <button
              className="set-btn"
              disabled
              title={t('settings.common.not_available_yet')}
            >
              {t('settings.sync.show_in_finder')}
            </button>
          }
        />
        <Row
          label={t('settings.sync.debug_toast')}
          desc={t('settings.sync.debug_toast_desc')}
          control={<Toggle on={syncDebugToasts} onChange={setSyncDebugToasts} />}
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.sync.history')} hint="SNAPSHOTS" />
        <Row
          label={t('settings.sync.auto_snapshot')}
          desc={<>{t('settings.sync.auto_snapshot_desc')}</>}
          control={
            <span title={t('settings.common.not_available_yet')}>
              <Toggle on={false} onChange={() => undefined} disabled />
            </span>
          }
        />
        <Row
          label={t('settings.sync.milestones')}
          desc={t('settings.sync.milestones_desc')}
          control={
            <button
              className="set-btn"
              disabled
              title={t('settings.common.not_available_yet')}
            >
              {t('settings.sync.view_milestones')}
            </button>
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.sync.import_files')} hint="IMPORT" />
        <Row
          label={t('settings.sync.import_files')}
          desc={t('settings.sync.import_files_desc')}
          control={
            <button
              className="set-btn"
              onClick={() => {
                events.emit('import:open');
              }}
            >
              {t('settings.sync.select_file')}
            </button>
          }
        />
      </div>
    </section>
  );
}

function PrivacyPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();

  return (
    <section className="set-panel" ref={registerRef} id="privacy">
      <PanelHead
        kicker={t('settings.privacy.kicker')}
        title={t('settings.privacy.title')}
        sub={t('settings.privacy.sub')}
      />

      <div className="set-note">
        {t('settings.privacy.noteA')}
        <br />
        <span className="set-mono" style={{ display: 'inline-block', marginTop: 6 }}>
          {t('settings.privacy.noteBPrefix')} <b>{t('settings.privacy.noteBStrong')}</b>{' '}
          {t('settings.privacy.noteBSuffix')}
        </span>
      </div>

      <div className="set-sec" style={{ marginTop: 18 }}>
        <SecHead title={t('settings.privacy.dataUsage')} hint="YOUR CONTROL" />
        <Row
          label={t('settings.privacy.improveModels')}
          desc={t('settings.privacy.improveModelsDesc')}
          control={
            <span title={t('settings.common.not_available_yet')}>
              <Toggle on={false} onChange={() => undefined} disabled />
            </span>
          }
        />
        <Row
          label={t('settings.privacy.usageStats')}
          desc={t('settings.privacy.usageStatsDesc')}
          control={
            <span title={t('settings.common.not_available_yet')}>
              <Toggle on={false} onChange={() => undefined} disabled />
            </span>
          }
        />
        <Row
          label={t('settings.privacy.crashLogs')}
          desc={t('settings.privacy.crashLogsDesc')}
          control={
            <span title={t('settings.common.not_available_yet')}>
              <Toggle on={false} onChange={() => undefined} disabled />
            </span>
          }
        />
      </div>

      <Row
        label={t('settings.privacy.fullPolicy')}
        desc={<span className="set-mono">{t('settings.privacy.lastUpdated')}</span>}
        control={
          <button className="set-btn" disabled title={t('settings.common.not_available_yet')}>
            {t('settings.common.open_in_browser')}
          </button>
        }
      />
    </section>
  );
}

function AboutPanel({ registerRef }: { registerRef: RegisterRef }) {
  const { t } = useTranslation();
  const appVersion = getPlatformRuntime().appInfo?.version ?? '0.1.0';
  return (
    <section className="set-panel" ref={registerRef} id="about">
      <PanelHead
        kicker={t('settings.about.kicker')}
        title={t('settings.about.title')}
        sub={t('settings.about.sub')}
      />

      <div className="set-about">
        <div className="set-about__glyph">D</div>
        <div className="set-about__main">
          <div className="set-about__name">
            Drifting <em>{t('settings.about.cnName')}</em>
          </div>
          <div className="set-about__meta">
            <span>
              {t('settings.about.version')} <b>{appVersion}</b>
            </span>
            <span>
              {t('settings.about.channel')} <b>{t('settings.about.channelPreAlpha')}</b>
            </span>
            <span>
              {t('settings.about.engine')} <b>Tiptap + SQLite</b>
            </span>
          </div>
        </div>
        <button className="set-btn" disabled title={t('settings.common.not_available_yet')}>
          {t('settings.about.checkUpdates')}
        </button>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SecHead title={t('settings.about.credits')} hint="CREDITS" />
        <Row
          label={<span className="set-italic">{t('settings.about.fonts')}</span>}
          desc={t('settings.about.fontsDesc')}
        />
        <Row
          label={<span className="set-italic">{t('settings.about.openSource')}</span>}
          desc="Tiptap · Yjs · Drizzle · React · Tauri 2"
          control={
            <button className="set-btn" disabled title={t('settings.common.not_available_yet')}>
              {t('settings.about.viewList')}
            </button>
          }
        />
      </div>

      <div className="set-sec">
        <SecHead title={t('settings.about.contact')} hint="HELLO" />
        <Row
          label={t('settings.about.emailTeam')}
          desc={<span className="set-mono">hi@drifting.app</span>}
          control={
            <button
              className="set-btn"
              onClick={() => void platform.material.openExternal('mailto:hi@drifting.app')}
            >
              {t('settings.about.writeEmail')}
            </button>
          }
        />
        <Row
          label={t('settings.about.submitFeedback')}
          desc={t('settings.about.submitFeedbackDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal(
                  'mailto:hi@drifting.app?subject=Drifting%20Pre-Alpha%20Feedback',
                )
              }
            >
              {t('settings.about.feedback')}
            </button>
          }
        />
      </div>

      <p
        style={{
          margin: '48px 0 0',
          fontFamily: 'var(--font-sans)',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'hsl(var(--ink-4))',
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        {t('settings.about.tagline')}
      </p>
    </section>
  );
}
