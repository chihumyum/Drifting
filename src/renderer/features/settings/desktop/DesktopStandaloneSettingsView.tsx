import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getPlatformRuntime } from '../../../platform/runtime';
import { StandaloneSettingsPanel } from '../StandaloneSettingsPanel';
import { hostedAccountSettingsEnabled, withoutHostedAccountSettings } from '../hosted-settings-policy';
import { BrushIcon, type BrushIconName } from '../../../components/ui/BrushIcon';

type StandaloneSettingsId =
  | 'account'
  | 'appearance'
  | 'language'
  | 'sync'
  | 'updates'
  | 'privacy'
  | 'about';

interface StandaloneSettingsItem {
  id: StandaloneSettingsId;
  icon: BrushIconName | null;
  labelKey: string;
}

interface StandaloneSettingsGroup {
  labelKey: string;
  items: StandaloneSettingsItem[];
}

const STANDALONE_SETTINGS_GROUPS: StandaloneSettingsGroup[] = [
  { labelKey: 'settings.groups.account', items: [{ id: 'account', icon: 'name-seal', labelKey: 'settings.rail.account' }] },
  {
    labelKey: 'settings.groups.preferences',
    items: [
      { id: 'appearance', icon: 'taiji', labelKey: 'settings.rail.appearance' },
      { id: 'language', icon: 'wen', labelKey: 'settings.rail.language' },
    ],
  },
  {
    labelKey: 'settings.groups.control',
    items: [
      { id: 'sync', icon: 'cloud', labelKey: 'settings.rail.sync' },
      { id: 'updates', icon: 'rotate', labelKey: 'settings.rail.updates' },
    ],
  },
  {
    labelKey: 'settings.groups.about',
    items: [
      { id: 'privacy', icon: 'lock-shut', labelKey: 'settings.rail.privacy' },
      { id: 'about', icon: null, labelKey: 'settings.rail.about_app' },
    ],
  },
];

const STANDALONE_SETTINGS_IDS = new Set<StandaloneSettingsId>(
  STANDALONE_SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
);

function isStandaloneSettingsId(value: string | null): value is StandaloneSettingsId {
  return !!value && STANDALONE_SETTINGS_IDS.has(value as StandaloneSettingsId);
}

export function DesktopStandaloneSettingsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const runtime = getPlatformRuntime();
  const groups = STANDALONE_SETTINGS_GROUPS.map(group => ({ ...group, items: withoutHostedAccountSettings(group.items, hostedAccountSettingsEnabled()) })).filter(group => group.items.length);
  const requestedSection = searchParams.get('section');
  const active: StandaloneSettingsId = isStandaloneSettingsId(requestedSection) && (requestedSection !== 'account' || hostedAccountSettingsEnabled())
    ? requestedSection
    : 'sync';
  const activeItem = groups.flatMap((group) => group.items).find(
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
            className="set-head__back glass glass--rest glass--round"
            onClick={handleBack}
            title={t('navigation.back')}
            aria-label={t('navigation.back')}
          >
            <BrushIcon name="arrow-back" size={16} />
          </button>
          <div className="set-head__title">{t('settings.title')}</div>
        </div>
      </header>

      <div className="set-body">
        <nav className="set-rail" aria-label={t('settings.title')}>
          {groups.map((group) => (
            <section className="set-rail__group" key={group.labelKey}>
              <h2 className="set-rail__group-title">{t(group.labelKey)}</h2>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`set-rail__item${
                    active === item.id ? ' set-rail__item--active is-current' : ''
                  }`}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() =>
                    setSearchParams({ section: item.id }, { replace: true, state: location.state })
                  }
                >
                  <span className="set-rail__glyph" aria-hidden="true">
                    {item.icon && <BrushIcon name={item.icon} size={14} />}
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
