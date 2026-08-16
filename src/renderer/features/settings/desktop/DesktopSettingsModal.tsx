import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { matchesAccelerator } from '../../../lib/shortcuts';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useAuthStore } from '../../../store/auth';
import { useFeatureAccessStore } from '../../../lib/feature-access';
import { AccountPanel } from '../../../features/settings/panels/AccountSettingsPanel';
import { SubscriptionPanel } from '../../../features/settings/panels/SubscriptionSettingsPanel';
import { AppearancePanel, EditorPanel, LanguagePanel, TrashRailPanel } from '../../../features/settings/panels/PreferenceSettingsPanels';
import { CopilotPanel, ModelsPanel } from '../../../features/settings/panels/IntelligenceSettingsPanels';
import { AgentPanel } from '../../../features/settings/panels/AgentSettingsPanel';
import { AboutPanel, KeysPanel, PrivacyPanel, SyncPanel } from '../../../features/settings/panels/ControlSettingsPanels';
import {
  hostedAccountSettingsEnabled,
  withoutHostedAccountSettings,
} from '../hosted-settings-policy';

interface DesktopSettingsModalProps {
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
  | 'models'
  | 'copilot'
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
    id: 'models',
    groupKey: 'settings.groups.intelligence',
    glyph: '◇',
    labelKey: 'settings.rail.models',
  },
  {
    id: 'copilot',
    groupKey: 'settings.groups.intelligence',
    glyph: '⌁',
    labelKey: 'settings.rail.copilot',
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
  'models',
  'copilot',
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
  const accountSettingsEnabled = hostedAccountSettingsEnabled();
  return useMemo<RailDef[]>(() => {
    return withoutHostedAccountSettings(RAIL_BASE, accountSettingsEnabled).map((r) => {
      const base = {
        id: r.id,
        group: t(
          r.id === 'trash' && !accountSettingsEnabled ? 'settings.groups.localData' : r.groupKey,
        ),
        glyph: r.glyph,
        label: t(r.labelKey),
      };
      if (r.id === 'subscription') {
        return { ...base, badge: { text: plan.toUpperCase() } };
      }
      return base;
    });
  }, [accountSettingsEnabled, plan, t]);
}

export function DesktopSettingsModal({ isOpen, onClose, initialRailId }: DesktopSettingsModalProps) {
  const accountSettingsEnabled = hostedAccountSettingsEnabled();
  const [active, setActive] = useState<RailId>(() =>
    accountSettingsEnabled ? 'account' : 'trash',
  );
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
    const hasDeepLink =
      !!initialRailId &&
      RAIL_IDS.has(initialRailId as RailId) &&
      RAIL.some((item) => item.id === initialRailId);
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
        <main className="set-main" ref={mainRef}>
          {accountSettingsEnabled && (
            <>
              <AccountPanel registerRef={(el) => (panelRefs.current.account = el ?? undefined)} />
              <SubscriptionPanel
                registerRef={(el) => (panelRefs.current.subscription = el ?? undefined)}
              />
            </>
          )}
          <TrashRailPanel registerRef={(el) => (panelRefs.current.trash = el ?? undefined)} />
          <AppearancePanel registerRef={(el) => (panelRefs.current.appearance = el ?? undefined)} />
          <EditorPanel registerRef={(el) => (panelRefs.current.editor = el ?? undefined)} />
          <LanguagePanel registerRef={(el) => (panelRefs.current.language = el ?? undefined)} />
          <ModelsPanel
            credentialsActive={active === 'models'}
            registerRef={(el) => (panelRefs.current.models = el ?? undefined)}
          />
          <CopilotPanel
            credentialsActive={active === 'copilot'}
            registerRef={(el) => (panelRefs.current.copilot = el ?? undefined)}
          />
          <AgentPanel
            open={isOpen}
            registerRef={(el) => (panelRefs.current.agent = el ?? undefined)}
          />
          <KeysPanel registerRef={(el) => (panelRefs.current.keys = el ?? undefined)} />
          <SyncPanel
            registerRef={(el) => (panelRefs.current.sync = el ?? undefined)}
            projectImportEnabled
          />
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
      className="set-head app-plane"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      style={{ paddingLeft: runtime.isMacDesktop ? 86 : 18 }}
    >
      <div className="set-head__left">
        <button
          type="button"
          className="set-head__back"
          onClick={onClose}
          title={t('navigation.back')}
          aria-label={t('navigation.back')}
        >
          <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <div className="set-head__title">{t('settings.title')}</div>
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
  const initial = (user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase();
  const groups: { name: string; items: RailDef[] }[] = [];
  for (const r of items) {
    const g = groups[groups.length - 1];
    if (g && g.name === r.group) g.items.push(r);
    else groups.push({ name: r.group, items: [r] });
  }

  return (
    <nav className="set-rail">
      <div className="set-rail__who">
        <div className="set-rail__who-avatar">{initial}</div>
        <div className="set-rail__who-body">
          <div className="set-rail__who-name">
            {user?.name ?? user?.email ?? t('settings.local_user')}
          </div>
          <div className="set-rail__who-meta">{t('settings.models.sidebarMeta')}</div>
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
