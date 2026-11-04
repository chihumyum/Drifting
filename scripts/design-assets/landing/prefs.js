// Apply preferences in the head before the page paints.
import { DOC_LANG_KEY, LANG_KEY, THEME_KEY, explicitLocale, homeFor, preferredLocale, readPreference } from './locales.mjs';

const root = document.documentElement;
const explicit = explicitLocale(location.hash);
const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
const preferred = preferredLocale(readPreference(LANG_KEY), languages);
let theme;
try { theme = sessionStorage.getItem(THEME_KEY); } catch {}
if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;

if (root.hasAttribute('data-landing')) {
  // A localized address identifies its own language. Only / auto-matches.
  const choice = explicit ?? (location.pathname === '/' ? preferred : root.dataset.lang);
  const destination = homeFor(choice);
  if (destination && choice !== root.dataset.lang) {
    location.replace(destination.path + location.search + location.hash);
  }
} else {
  const saved = readPreference(DOC_LANG_KEY);
  const info = explicit ? homeFor(explicit).infoLang : saved === 'en' || saved === 'zh' ? saved : homeFor(preferred).infoLang;
  root.dataset.lang = info;
  root.lang = info === 'zh' ? 'zh-CN' : 'en';
}
