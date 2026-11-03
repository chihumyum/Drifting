import { useTranslation } from 'react-i18next';
import { useSettingsStore, type ThemeMode } from '../../../store/settings-store';
import { UI_LOCALE_OPTIONS } from '../../../lib/i18n';
import { ACCENT_COLOR_DEFAULT_DARK, ACCENT_COLOR_DEFAULT_LIGHT } from '../../../lib/theme';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import {
  SettingsButton,
  SettingsColor,
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSegment,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { settingsOnDesktop } from '../settings-on-desktop';
import { BrushIcon, type BrushIconName } from '../../../components/ui/BrushIcon';

export function AppearancePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const interfaceTextSize = useSettingsStore((s) => s.interfaceTextSize);
  const setInterfaceTextSize = useSettingsStore((s) => s.setInterfaceTextSize);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const agentEditRevealAnimation = useSettingsStore((s) => s.agentEditRevealAnimation);
  const setAgentEditRevealAnimation = useSettingsStore((s) => s.setAgentEditRevealAnimation);
  const guidesSeen = useSettingsStore((s) => s.guidesSeen);
  const resetGuides = useSettingsStore((s) => s.resetGuides);
  const resolvedTheme =
    themeMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : themeMode;
  const displayedAccentColor =
    accentColor ??
    (resolvedTheme === 'dark' ? ACCENT_COLOR_DEFAULT_DARK : ACCENT_COLOR_DEFAULT_LIGHT);

  const themes: { value: ThemeMode; name: string; kind: string; tp: string; icon: BrushIconName }[] = [
    { value: 'light', name: t('settings.appearance.light'), kind: 'LIGHT', tp: 'tp--light', icon: 'enso' },
    { value: 'dark', name: t('settings.appearance.dark'), kind: 'DARK', tp: 'tp--dark', icon: 'ink-disc' },
    { value: 'system', name: t('settings.appearance.system'), kind: 'SYSTEM', tp: 'tp--system', icon: 'taiji' },
  ];
  const desktop = settingsOnDesktop();

  return (
    <section className="set-panel" ref={registerRef} id="appearance">
      <SettingsPanelHeader
        kicker={t('settings.appearance.kicker')}
        title={t('settings.appearance.title')}
        sub={t('settings.appearance.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.theme')} hint="THEME" />
        {desktop ? (
          // The interface itself is the preview: one choice, like the account menu.
          <SettingsRow
            label={t('settings.appearance.theme')}
            desc={t('settings.appearance.theme_desc')}
            control={
              <GlassSlider
                value={themeMode}
                onChange={setThemeMode}
                ariaLabel={t('settings.appearance.theme')}
                options={themes.map((theme) => ({
                  value: theme.value,
                  label: (
                    <span className="set-choice-label">
                      <BrushIcon name={theme.icon} size={13} />
                      {theme.name}
                    </span>
                  ),
                }))}
              />
            }
          />
        ) : (
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
                <div className="set-theme-card__check"><BrushIcon name="check" size={10} /></div>
              </button>
            ))}
          </div>
        )}
      </div>

      {desktop && (
        <div className="set-sec">
          <SettingsSectionHeader title={t('settings.appearance.interface_text_size')} />
          <SettingsRow
            label={t('settings.appearance.interface_text_size')}
            desc={t('settings.appearance.interface_text_size_desc')}
            control={
              <SettingsSegment
                value={interfaceTextSize}
                onChange={setInterfaceTextSize}
                ariaLabel={t('settings.appearance.interface_text_size')}
                options={[
                  { value: 'smallest', label: t('settings.appearance.interface_text_smallest') },
                  { value: 'small', label: t('settings.appearance.interface_text_small') },
                  { value: 'standard', label: t('settings.appearance.interface_text_standard') },
                  { value: 'large', label: t('settings.appearance.interface_text_large') },
                  { value: 'largest', label: t('settings.appearance.interface_text_largest') },
                ]}
              />
            }
          />
        </div>
      )}

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.accent')} hint="ACCENT" />
        <SettingsRow
          label={t('settings.appearance.accent_color')}
          desc={t('settings.appearance.accent_color_desc')}
          control={
            <SettingsColor
              value={displayedAccentColor}
              onChange={setAccentColor}
              ariaLabel={t('settings.appearance.accent_color')}
            >
              {accentColor && (
                <SettingsButton variant="ghost" size="sm" onClick={() => setAccentColor(null)}>
                  {t('settings.appearance.accent_reset')}
                </SettingsButton>
              )}
            </SettingsColor>
          }
        />
      </div>
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.animations')} hint="MOTION" />
        <SettingsRow
          label={t('settings.appearance.agent_edit_reveal')}
          desc={t('settings.appearance.agent_edit_reveal_desc')}
          control={
            <SettingsToggle
              on={agentEditRevealAnimation}
              onChange={setAgentEditRevealAnimation}
              aria-label={t('settings.appearance.agent_edit_reveal')}
            />
          }
        />
      </div>
      {desktop && (
        <div className="set-sec">
          <SettingsSectionHeader title={t('settings.appearance.guides')} hint="GUIDE" />
          <SettingsRow
            label={t('settings.appearance.replay_guides')}
            control={
              <SettingsButton variant="ghost" disabled={guidesSeen.length === 0} onClick={resetGuides}>
                {t('settings.appearance.replay_guides_action')}
              </SettingsButton>
            }
          />
        </div>
      )}
    </section>
  );
}

export function LanguagePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const uiLocale = useSettingsStore((s) => s.uiLocale);
  const setUiLocale = useSettingsStore((s) => s.setUiLocale);
  const normalizedUiLocale = uiLocale.startsWith('zh') ? 'zh-CN' : 'en';

  return (
    <section className="set-panel" ref={registerRef} id="language">
      <SettingsPanelHeader
        kicker={t('settings.language.kicker')}
        title={t('settings.language.title')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.language.ui_locale')} hint="UI LOCALE" />
        {settingsOnDesktop() ? (
          <SettingsRow
            label={t('settings.language.ui_locale')}
            desc={t('settings.language.ui_locale_desc')}
            control={
              <SettingsSegment
                value={normalizedUiLocale}
                onChange={setUiLocale}
                ariaLabel={t('settings.language.ui_locale')}
                options={UI_LOCALE_OPTIONS.map((locale) => ({ value: locale.code, label: locale.name }))}
              />
            }
          />
        ) : (
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
        )}
      </div>
    </section>
  );
}
