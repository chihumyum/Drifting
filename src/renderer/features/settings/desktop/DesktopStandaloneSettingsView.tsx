import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getPlatformRuntime } from '../../../platform/runtime';
import {
  AppearancePanel,
  LanguagePanel,
} from '../panels/PreferenceSettingsPanels';
import {
  AboutPanel,
  PrivacyPanel,
  SyncPanel,
  UpdatePanel,
} from '../panels/ControlSettingsPanels';

type StandaloneSettingsId =
  | 'appearance'
  | 'language'
  | 'sync'
  | 'updates'
  | 'privacy'
  | 'about';

interface StandaloneSettingsItem {
  id: StandaloneSettingsId;
  glyph: string;
  labelKey: string;
}

interface StandaloneSettingsGroup {
  labelKey: string;
  items: StandaloneSettingsItem[];
}

const STANDALONE_SETTINGS_GROUPS: StandaloneSettingsGroup[] = [
  {
    labelKey: 'settings.groups.preferences',
    items: [
      { id: 'appearance', glyph: '☀', labelKey: 'settings.rail.appearance' },
      { id: 'language', glyph: '文', labelKey: 'settings.rail.language' },
    ],
  },
  {
    labelKey: 'settings.groups.control',
    items: [
      { id: 'sync', glyph: '⇅', labelKey: 'settings.rail.sync' },
      { id: 'updates', glyph: '↻', labelKey: 'settings.rail.updates' },
    ],
  },
  {
    labelKey: 'settings.groups.about',
    items: [
      { id: 'privacy', glyph: '⚷', labelKey: 'settings.rail.privacy' },
      { id: 'about', glyph: '渡', labelKey: 'settings.rail.about_app' },
    ],
  },
];

const STANDALONE_SETTINGS_IDS = new Set<StandaloneSettingsId>(
  STANDALONE_SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
);
const REGISTER_NOOP = () => undefined;

function isStandaloneSettingsId(value: string | null): value is StandaloneSettingsId {
  return !!value && STANDALONE_SETTINGS_IDS.has(value as StandaloneSettingsId);
}

function StandaloneSettingsPanel({ id }: { id: StandaloneSettingsId }) {
  switch (id) {
    case 'appearance':
      return <AppearancePanel registerRef={REGISTER_NOOP} />;
    case 'language':
      return <LanguagePanel registerRef={REGISTER_NOOP} />;
    case 'sync':
      return <SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />;
    case 'updates':
      return <UpdatePanel registerRef={REGISTER_NOOP} />;
    case 'privacy':
      return <PrivacyPanel registerRef={REGISTER_NOOP} />;
    case 'about':
      return <AboutPanel registerRef={REGISTER_NOOP} />;
  }
}

export function DesktopStandaloneSettingsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const runtime = getPlatformRuntime();
  const requestedSection = searchParams.get('section');
  const active: StandaloneSettingsId = isStandaloneSettingsId(requestedSection)
    ? requestedSection
    : 'sync';
  const activeItem = STANDALONE_SETTINGS_GROUPS.flatMap((group) => group.items).find(
    (item) => item.id === active,
  );

  const handleBack = () => {
    const from = (location.state as { from?: unknown } | null)?.from;
    navigate(typeof from === 'string' && from.startsWith('/') ? from : '/', { replace: true });
  };

  return (
    <div className="set-overlay" aria-label={t('settings.title')}>
      <header
        className="set-head app-plane"
        data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
        style={{ paddingLeft: runtime.isMacDesktop ? 86 : 18 }}
      >
        <div className="set-head__left">
          <button
            type="button"
            className="set-head__back"
            onClick={handleBack}
            title={t('navigation.back')}
            aria-label={t('navigation.back')}
          >
            <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <div className="set-head__title">{t('settings.title')}</div>
        </div>
      </header>

      <div className="set-body">
        <nav className="set-rail" aria-label={t('settings.title')}>
          {STANDALONE_SETTINGS_GROUPS.map((group) => (
            <section className="set-rail__group" key={group.labelKey}>
              <h2 className="set-rail__group-title">{t(group.labelKey)}</h2>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`set-rail__item${
                    active === item.id ? ' set-rail__item--active' : ''
                  }`}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() =>
                    setSearchParams({ section: item.id }, { replace: true, state: location.state })
                  }
                >
                  <span className="set-rail__glyph" aria-hidden="true">
                    {item.glyph}
                  </span>
                  <span className="set-rail__label">{t(item.labelKey)}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>

        <main className="set-main" aria-label={activeItem && t(activeItem.labelKey)}>
          <StandaloneSettingsPanel id={active} />
        </main>
      </div>
    </div>
  );
}
