import { UI_LOCALE_OPTIONS, detectUiLocale, matchUiLocale } from '../../../src/shared/ui-locales.ts';

const routes = {
  en: ['/', 'en', 'en_US'],
  'zh-CN': ['/zh', 'zh-Hans', 'zh_CN'],
  'zh-TW': ['/zh-tw', 'zh-Hant', 'zh_TW'],
  ja: ['/ja', 'ja', 'ja_JP'],
  ko: ['/ko', 'ko', 'ko_KR'],
  es: ['/es', 'es', 'es_ES'],
  de: ['/de', 'de', 'de_DE'],
  fr: ['/fr', 'fr', 'fr_FR'],
  'pt-BR': ['/pt-br', 'pt-BR', 'pt_BR'],
};

export const ORIGIN = 'https://drifting.cc';
export const LANG_KEY = 'drifting.landing.lang';
export const DOC_LANG_KEY = 'drifting.landing.docs.lang';
export const THEME_KEY = 'drifting.landing.theme';

export const HOMES = Object.entries(routes).map(([locale, [path, hreflang, ogLocale]]) => ({
  locale,
  path,
  file: path === '/' ? 'index.html' : path.slice(1) + '.html',
  label: UI_LOCALE_OPTIONS.find(({ code }) => code === locale).native,
  hreflang,
  ogLocale,
  infoLang: locale.startsWith('zh') ? 'zh' : 'en',
  cjk: /^(?:zh|ja|ko)/.test(locale),
}));

const byLocale = new Map(HOMES.map((home) => [home.locale, home]));
export const homeFor = (locale) => byLocale.get(locale);

export function explicitLocale(hash) {
  const code = hash.slice(1).toLowerCase();
  if (code === 'zh') return 'zh-CN';
  return HOMES.find((home) => home.locale.toLowerCase() === code)?.locale;
}

export function preferredLocale(saved, languages) {
  return matchUiLocale(saved) ?? detectUiLocale(languages);
}

export function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
