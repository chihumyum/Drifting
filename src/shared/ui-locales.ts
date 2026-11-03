/** Interface locales shared by the app, preference sync and the share reader.
 * Regional variants resolve here; unsupported languages fall back to English.
 */
export const UI_LOCALE_OPTIONS = [
  { code: 'zh-CN', name: '中文（简体）', native: '简体中文' },
  { code: 'zh-TW', name: '中文（繁體）', native: '繁體中文' },
  { code: 'en', name: 'English', native: 'English' },
  { code: 'ja', name: '日本語', native: '日本語' },
  { code: 'ko', name: '한국어', native: '한국어' },
  { code: 'es', name: 'Español', native: 'Español' },
  { code: 'de', name: 'Deutsch', native: 'Deutsch' },
  { code: 'fr', name: 'Français', native: 'Français' },
  { code: 'pt-BR', name: 'Português (Brasil)', native: 'Português (Brasil)' },
] as const;

export type SupportedLocale = (typeof UI_LOCALE_OPTIONS)[number]['code'];
export const SUPPORTED_LOCALES = UI_LOCALE_OPTIONS.map((locale) => locale.code);

export function matchUiLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().replaceAll('_', '-').toLowerCase();
  const parts = code.split('-');
  if (parts[0] === 'zh') {
    if (parts.includes('hant')) return 'zh-TW';
    if (parts.includes('hans')) return 'zh-CN';
    return parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN';
  }
  if (parts[0] === 'pt') return 'pt-BR';
  return SUPPORTED_LOCALES.find((locale) => locale === parts[0]);
}

export function normalizeUiLocale(value: unknown): SupportedLocale {
  return matchUiLocale(value) ?? 'en';
}

export function detectUiLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const locale = matchUiLocale(language);
    if (locale) return locale;
  }
  return 'en';
}

/** Safe before React mounts and in restricted webviews. Explicit choices win. */
export function readInitialUiLocale(): SupportedLocale {
  try {
    const raw = globalThis.localStorage?.getItem('settings-storage');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'state' in parsed) {
        const state = parsed.state;
        if (state && typeof state === 'object' && 'uiLocale' in state) {
          const locale = matchUiLocale(state.uiLocale);
          if (locale) return locale;
        }
      }
    }
  } catch {
    // Missing, corrupt or restricted storage falls back to system preferences.
  }
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
  return detectUiLocale(languages?.length ? languages : [typeof navigator === 'undefined' ? 'en' : navigator.language]);
}
