import { useCallback } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleUserRound,
  Cloud,
  CodeXml,
  CreditCard,
  Info,
  KeyRound,
  Languages,
  Palette,
  PenLine,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  icon: LucideIcon;
}

interface MobileSettingsGroup {
  labelKey: string;
  items: MobileSettingsItem[];
}

const MOBILE_SETTINGS_GROUPS: MobileSettingsGroup[] = [
  {
    labelKey: 'settings.groups.account',
    items: [
      { id: 'account', labelKey: 'settings.rail.account', icon: CircleUserRound },
      { id: 'subscription', labelKey: 'settings.rail.subscription', icon: CreditCard },
    ],
  },
  {
    labelKey: 'settings.groups.preferences',
    items: [
      { id: 'appearance', labelKey: 'settings.rail.appearance', icon: Palette },
      { id: 'editor', labelKey: 'settings.rail.editor', icon: PenLine },
      { id: 'language', labelKey: 'settings.rail.language', icon: Languages },
    ],
  },
  {
    labelKey: 'settings.groups.intelligence',
    items: [
      { id: 'models', labelKey: 'settings.rail.models', icon: Bot },
      { id: 'copilot', labelKey: 'settings.rail.copilot', icon: Sparkles },
    ],
  },
  {
    labelKey: 'settings.groups.control',
    items: [
      { id: 'keys', labelKey: 'settings.rail.keys', icon: KeyRound },
      { id: 'sync', labelKey: 'settings.rail.sync', icon: Cloud },
    ],
  },
  {
    labelKey: 'settings.groups.about',
    items: [
      { id: 'privacy', labelKey: 'settings.rail.privacy', icon: ShieldCheck },
      { id: 'about', labelKey: 'settings.rail.about_app', icon: Info },
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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get('section');
  const active = isMobileSettingsId(requestedSection) ? requestedSection : null;
  const activeItem = MOBILE_SETTINGS_GROUPS.flatMap((group) => group.items).find(
    (item) => item.id === active,
  );

  const closeSection = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const handleBack = () => {
    if (active) closeSection();
    else navigate('/', { replace: true });
  };

  return (
    <main className="m-settings">
      <header className="m-settings__head">
        <button type="button" onClick={handleBack} aria-label={t('navigation.back')}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <div>
          <span>{active ? t('settings.title') : 'Drifting'}</span>
          <strong>{activeItem ? t(activeItem.labelKey) : t('settings.title')}</strong>
        </div>
        <span aria-hidden="true" />
      </header>

      {active ? (
        <section className="m-settings__content" aria-label={activeItem && t(activeItem.labelKey)}>
          <MobileSettingsPanel id={active} />
        </section>
      ) : (
        <div className="m-settings__index">
          {MOBILE_SETTINGS_GROUPS.map((group) => (
            <section key={group.labelKey}>
              <h2>{t(group.labelKey)}</h2>
              <div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSearchParams({ section: item.id })}
                    >
                      <Icon size={19} strokeWidth={1.65} aria-hidden="true" />
                      <span>{t(item.labelKey)}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          <section className="m-settings__project-boundary">
            <CodeXml size={18} aria-hidden="true" />
            <div>
              <strong>{t('settings.groups.project', { defaultValue: '项目设置' })}</strong>
              <p>
                {t('settings.mobile.projectDeferred', {
                  defaultValue: '废纸篓、Agent memory 和项目用量将在移动工作区方案中接入。',
                })}
              </p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
