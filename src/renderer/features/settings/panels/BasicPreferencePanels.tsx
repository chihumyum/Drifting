import { useTranslation } from 'react-i18next';
import { useSettingsStore, type DateFormat, type LocaleCode, type ThemeMode } from '../../../store/settings-store';
import { UI_LOCALE_OPTIONS } from '../../../lib/i18n';
import { ACCENT_COLOR_DEFAULT_DARK, ACCENT_COLOR_DEFAULT_LIGHT } from '../../../lib/theme';
import {
  SettingsPanelHeader, SettingsRow, SettingsSectionHeader, SettingsSegment,
  SettingsToggle, type SettingsRegisterRef,
} from '../SettingsPrimitives';

export function AppearancePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const resolvedTheme =
    themeMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : themeMode;
  const displayedAccentColor =
    accentColor ??
    (resolvedTheme === 'dark' ? ACCENT_COLOR_DEFAULT_DARK : ACCENT_COLOR_DEFAULT_LIGHT);

  const themes: { value: ThemeMode; name: string; kind: string; tp: string }[] = [
    { value: 'light', name: t('settings.appearance.light'), kind: 'LIGHT', tp: 'tp--light' },
    { value: 'dark', name: t('settings.appearance.dark'), kind: 'DARK', tp: 'tp--dark' },
    { value: 'system', name: t('settings.appearance.system'), kind: 'SYSTEM', tp: 'tp--system' },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="appearance">
      <SettingsPanelHeader
        kicker={t('settings.appearance.kicker')}
        title={t('settings.appearance.title')}
        sub={t('settings.appearance.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.theme')} hint="THEME" />
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

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.accent')} hint="ACCENT" />
        <SettingsRow
          label={t('settings.appearance.accent_color')}
          desc={t('settings.appearance.accent_color_desc')}
          control={
            <div className="set-color-picker">
              <input
                className="set-color-picker__input"
                type="color"
                value={displayedAccentColor}
                aria-label={t('settings.appearance.accent_color')}
                onChange={(event) => setAccentColor(event.target.value)}
              />
              <span className="set-color-picker__value">{displayedAccentColor.toUpperCase()}</span>
              {accentColor && (
                <button
                  type="button"
                  className="set-btn set-btn--ghost"
                  onClick={() => setAccentColor(null)}
                >
                  {t('settings.appearance.accent_reset')}
                </button>
              )}
            </div>
          }
        />
      </div>
    </section>
  );
}

export function LanguagePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
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
      <SettingsPanelHeader
        kicker={t('settings.language.kicker')}
        title={t('settings.language.title')}
        sub={t('settings.language.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.language.ui_locale')} hint="UI LOCALE" />
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
        <SettingsSectionHeader title={t('settings.language.manuscript')} hint="MANUSCRIPT" />
        <SettingsRow
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
        <SettingsRow
          label={t('settings.language.spellcheck')}
          desc={t('settings.language.spellcheck_desc')}
          control={<SettingsToggle on={spellcheck} onChange={setSpellcheck} />}
        />
        <SettingsRow
          label={t('settings.language.date_format')}
          desc={t('settings.language.date_format_desc')}
          control={
            <SettingsSegment<DateFormat>
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
