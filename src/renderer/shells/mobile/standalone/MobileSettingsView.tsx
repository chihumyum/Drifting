import { useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AccountPanel } from '../../../features/settings/panels/AccountSettingsPanel';
import { SubscriptionPanel } from '../../../features/settings/panels/SubscriptionSettingsPanel';
import {
  AppearancePanel,
  EditorPanel,
  LanguagePanel,
} from '../../../features/settings/panels/PreferenceSettingsPanels';
import {
  CopilotPanel,
  ModelsPanel,
} from '../../../features/settings/panels/IntelligenceSettingsPanels';
import {
  AboutPanel,
  KeysPanel,
  PrivacyPanel,
  SyncPanel,
} from '../../../features/settings/panels/ControlSettingsPanels';
import '../../../../styles/mobile-settings.css';

const MOBILE_SETTINGS_IDS = [
  'account',
  'subscription',
  'appearance',
  'editor',
  'language',
  'models',
  'copilot',
  'keys',
  'sync',
  'privacy',
  'about',
] as const;

type MobileSettingsId = (typeof MOBILE_SETTINGS_IDS)[number];

interface MobileSettingsItem {
  id: MobileSettingsId;
  labelKey: string;
}

interface MobileSettingsGroup {
  labelKey: string;
  items: MobileSettingsItem[];
}

const MOBILE_SETTINGS_GROUPS: MobileSettingsGroup[] = [
  {
    labelKey: 'settings.groups.account',
    items: [
      { id: 'account', labelKey: 'settings.rail.account' },
      { id: 'subscription', labelKey: 'settings.rail.subscription' },
    ],
  },
  {
    labelKey: 'settings.groups.preferences',
    items: [
      { id: 'appearance', labelKey: 'settings.rail.appearance' },
      { id: 'editor', labelKey: 'settings.rail.editor' },
      { id: 'language', labelKey: 'settings.rail.language' },
    ],
  },
  {
    labelKey: 'settings.groups.intelligence',
    items: [
      { id: 'models', labelKey: 'settings.rail.models' },
      { id: 'copilot', labelKey: 'settings.rail.copilot' },
    ],
  },
  {
    labelKey: 'settings.groups.control',
    items: [
      { id: 'keys', labelKey: 'settings.rail.keys' },
      { id: 'sync', labelKey: 'settings.rail.sync' },
    ],
  },
  {
    labelKey: 'settings.groups.about',
    items: [
      { id: 'privacy', labelKey: 'settings.rail.privacy' },
      { id: 'about', labelKey: 'settings.rail.about_app' },
    ],
  },
];

const REGISTER_NOOP = () => undefined;

function isMobileSettingsId(value: string | null): value is MobileSettingsId {
  return !!value && (MOBILE_SETTINGS_IDS as readonly string[]).includes(value);
}

function MobileSettingsPanel({ id }: { id: MobileSettingsId }) {
  switch (id) {
    case 'account':
      return <AccountPanel registerRef={REGISTER_NOOP} />;
    case 'subscription':
      return <SubscriptionPanel registerRef={REGISTER_NOOP} />;
    case 'appearance':
      return <AppearancePanel registerRef={REGISTER_NOOP} />;
    case 'editor':
      return <EditorPanel registerRef={REGISTER_NOOP} />;
    case 'language':
      return <LanguagePanel registerRef={REGISTER_NOOP} />;
    case 'models':
      return <ModelsPanel credentialsActive registerRef={REGISTER_NOOP} />;
    case 'copilot':
      return <CopilotPanel credentialsActive registerRef={REGISTER_NOOP} />;
    case 'keys':
      return <KeysPanel registerRef={REGISTER_NOOP} />;
    case 'sync':
      return <SyncPanel registerRef={REGISTER_NOOP} />;
    case 'privacy':
      return <PrivacyPanel registerRef={REGISTER_NOOP} />;
    case 'about':
      return <AboutPanel registerRef={REGISTER_NOOP} />;
  }
}

export function MobileSettingsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get('section');
  const active = isMobileSettingsId(requestedSection) ? requestedSection : null;
  const activeItem = MOBILE_SETTINGS_GROUPS.flatMap((group) => group.items).find(
    (item) => item.id === active,
  );

  const closeSection = useCallback(() => {
    setSearchParams({}, { replace: true, state: location.state });
  }, [location.state, setSearchParams]);

  const handleBack = () => {
    if (active) closeSection();
    else {
      const from = (location.state as { from?: unknown } | null)?.from;
      navigate(typeof from === 'string' && from.startsWith('/') ? from : '/', { replace: true });
    }
  };

  return (
    <div className="m-settings set-overlay">
      <header className="m-settings__head set-head">
        <div className="set-head__left">
          <button
            type="button"
            className="set-head__back"
            onClick={handleBack}
            aria-label={t('navigation.back')}
          >
            <ArrowLeft size={17} aria-hidden="true" />
          </button>
          <span className="set-head__title">
            {activeItem ? t(activeItem.labelKey) : t('settings.title')}
          </span>
        </div>
      </header>

      <div className="m-settings__body set-body">
        {active ? (
          <main
            className="m-settings__content set-main"
            aria-label={activeItem && t(activeItem.labelKey)}
          >
            <MobileSettingsPanel id={active} />
          </main>
        ) : (
          <nav className="m-settings__index set-rail" aria-label={t('settings.title')}>
            {MOBILE_SETTINGS_GROUPS.map((group) => (
              <section className="set-rail__group" key={group.labelKey}>
                <h2 className="set-rail__group-title">{t(group.labelKey)}</h2>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="set-rail__item"
                    onClick={() => setSearchParams({ section: item.id }, { state: location.state })}
                  >
                    <span className="set-rail__label">{t(item.labelKey)}</span>
                  </button>
                ))}
              </section>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
