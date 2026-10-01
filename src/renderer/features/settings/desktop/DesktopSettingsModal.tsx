import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { matchesAccelerator } from '../../../lib/shortcuts';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useSettingsPanels } from '../useSettingsPanels';
import { SettingsLoadStatus } from '../SettingsLoadStatus';
import { TrashRailPanel } from '../panels/TrashSettingsPanel';
import { DesktopSettingsRail } from './DesktopSettingsRail';
import {
  filterSettingsNavigation,
  readSettingsSections,
  sameSettingsSections,
  settingsItemAtTop,
  settingsTargetScrollTop,
  type SettingsNavigationSection,
  type SettingsSections,
} from './settings-section-navigation';

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
  | 'trash'
  | 'appearance'
  | 'editor'
  | 'language'
  | 'models'
  | 'copilot'
  | 'agent'
  | 'keys'
  | 'sync'
  | 'updates'
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

const RAIL_BASE: RailBaseDef[] = [
  {
    id: 'account',
    groupKey: 'settings.groups.account',
    glyph: '◌',
    labelKey: 'settings.rail.account',
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
    id: 'updates',
    groupKey: 'settings.groups.control',
    glyph: '↻',
    labelKey: 'settings.rail.updates',
  },
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
  'trash',
  'appearance',
  'editor',
  'language',
  'models',
  'copilot',
  'agent',
  'keys',
  'sync',
  'updates',
  'privacy',
  'about',
]);

function useRail(): RailDef[] {
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
      return base;
    });
  }, [accountSettingsEnabled, t]);
}

export function DesktopSettingsModal({ isOpen, onClose, initialRailId }: DesktopSettingsModalProps) {
  const accountSettingsEnabled = hostedAccountSettingsEnabled();
  const [active, setActive] = useState<RailId>(() =>
    accountSettingsEnabled ? 'account' : 'trash',
  );
  const [query, setQuery] = useState('');
  const [sections, setSections] = useState<SettingsSections>({});
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Partial<Record<RailId, HTMLElement>>>({});
  const RAIL = useRail();
  const { panels, failed, retry } = useSettingsPanels(isOpen);
  const pendingRailRef = useRef<RailId | null>(null);
  const registerPanel = useCallback((id: RailId, element: HTMLElement | null) => {
    panelRefs.current[id] = element ?? undefined;
  }, []);

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

  // Headings own their labels and presence; the rail follows deferred content,
  // conditional sections and language changes without a second section catalog.
  useEffect(() => {
    const main = mainRef.current;
    if (!isOpen || !main) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readSettingsSections(main);
        setSections(previous => sameSettingsSections(previous, next) ? previous : next);
      });
    };
    const observer = new MutationObserver(refresh);
    observer.observe(main, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-settings-section', 'hidden'] });
    refresh();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [isOpen]);

  // Scroll-spy keeps both levels aligned with manual scrolling.
  useEffect(() => {
    if (!isOpen) return;
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => {
      const top = main.getBoundingClientRect().top + 100;
      const mounted = RAIL.flatMap(r => {
        const element = panelRefs.current[r.id];
        return element ? [{ id: r.id, element }] : [];
      });
      const atBottom = main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
      const current = (atBottom ? mounted[mounted.length - 1] : settingsItemAtTop(mounted, top)) ?? mounted[0];
      if (!current) return;
      const children = sections[current.id] ?? [];
      const child = atBottom ? children[children.length - 1] : settingsItemAtTop(children, top);
      setActive(current.id);
      setActiveSection(child?.id ?? null);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    const frame = requestAnimationFrame(onScroll);
    return () => { main.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [isOpen, RAIL, sections]);

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
    pendingRailRef.current = target;
    const apply = () => {
      // Set the rail highlight here (deferred in the rAF, not synchronously in
      // the effect body) so it lands together with the scroll.
      if (hasDeepLink) setActive(target);
      const el = panelRefs.current[target];
      const main = mainRef.current;
      if (el && main) main.scrollTo({ top: settingsTargetScrollTop(main, el), behavior: 'auto' });
    };
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
    // `active` intentionally omitted — we only want the value at open time,
    // not a re-scroll on every scroll-spy update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialRailId]);

  // A rail can be selected while its code is loading. Scroll only after the
  // selected panel has mounted, without replacing the shell or resetting query.
  useEffect(() => {
    if (!isOpen || !panels) return;
    const raf = requestAnimationFrame(() => {
      const el = panelRefs.current[pendingRailRef.current ?? active];
      if (el && mainRef.current) mainRef.current.scrollTo({ top: settingsTargetScrollTop(mainRef.current, el), behavior: 'auto' });
    });
    return () => cancelAnimationFrame(raf);
    // Selection changes already scroll in onRail; loading completion is separate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, panels]);

  const onRail = useCallback((id: RailId, section?: SettingsNavigationSection) => {
    pendingRailRef.current = id;
    setActive(id);
    setActiveSection(section?.id ?? null);
    const el = section?.element ?? panelRefs.current[id];
    const main = mainRef.current;
    if (el && main) main.scrollTo({ top: settingsTargetScrollTop(main, el), behavior: 'auto' });
  }, []);

  const filtered = useMemo(() => filterSettingsNavigation(RAIL, sections, query), [query, RAIL, sections]);

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
        <DesktopSettingsRail items={filtered} active={active} activeSection={activeSection} onSelect={onRail} />
        <main className="set-main set-main--instant-section-nav" ref={mainRef}>
          {panels ? (
            <LoadedSettingsPanels
              panels={panels}
              accountSettingsEnabled={accountSettingsEnabled}
              active={active}
              isOpen={isOpen}
              registerPanel={registerPanel}
            />
          ) : (
            <SettingsLoadStatus failed={failed} retry={retry} />
          )}
        </main>
      </div>
    </div>
  );
}

function LoadedSettingsPanels({ panels, accountSettingsEnabled, active, isOpen, registerPanel }: {
  panels: NonNullable<ReturnType<typeof useSettingsPanels>['panels']>;
  accountSettingsEnabled: boolean;
  active: RailId;
  isOpen: boolean;
  registerPanel: (id: RailId, element: HTMLElement | null) => void;
}) {
  const { AccountPanel, AppearancePanel, EditorPanel, LanguagePanel,
    ModelsPanel, CopilotPanel, AgentPanel, KeysPanel, SyncPanel, UpdatePanel, PrivacyPanel, AboutPanel } = panels;
  return (
    <>
      {accountSettingsEnabled && (
        <>
          <AccountPanel registerRef={(el) => registerPanel('account', el)} />
        </>
      )}
      <TrashRailPanel registerRef={(el) => registerPanel('trash', el)} />
      <AppearancePanel registerRef={(el) => registerPanel('appearance', el)} />
      <EditorPanel registerRef={(el) => registerPanel('editor', el)} />
      <LanguagePanel registerRef={(el) => registerPanel('language', el)} />
      <ModelsPanel
        credentialsActive={active === 'models'}
        registerRef={(el) => registerPanel('models', el)}
      />
      <CopilotPanel
        credentialsActive={active === 'copilot'}
        registerRef={(el) => registerPanel('copilot', el)}
      />
      <AgentPanel
        open={isOpen}
        registerRef={(el) => registerPanel('agent', el)}
      />
      <KeysPanel registerRef={(el) => registerPanel('keys', el)} />
      <SyncPanel
        registerRef={(el) => registerPanel('sync', el)}
        projectImportEnabled
      />
      <UpdatePanel registerRef={(el) => registerPanel('updates', el)} />
      <PrivacyPanel registerRef={(el) => registerPanel('privacy', el)} />
      <AboutPanel registerRef={(el) => registerPanel('about', el)} />
    </>
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
