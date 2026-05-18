import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import fr from '../locales/fr.json';

export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Read the persisted UI locale synchronously from localStorage so the very
// first render never flashes the wrong language. The settings store also
// reads from the same key — they stay in sync because both write via
// useSettingsStore.setUiLocale.
function getInitialLocale(): SupportedLocale {
  try {
    const raw = localStorage.getItem('settings-storage');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { uiLocale?: SupportedLocale } };
      const persisted = parsed?.state?.uiLocale;
      if (persisted && SUPPORTED_LOCALES.includes(persisted)) return persisted;
    }
  } catch {
    // ignore — fall through to system detection
  }
  const nav = (navigator.language ?? 'en') as string;
  if (nav.startsWith('zh-TW') || nav.startsWith('zh-HK')) return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('fr')) return 'fr';
  return 'en';
}

void i18next
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      en: { translation: en },
      ja: { translation: ja },
      ko: { translation: ko },
      fr: { translation: fr },
    },
    lng: getInitialLocale(),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export function setI18nLocale(locale: SupportedLocale): void {
  void i18next.changeLanguage(locale);
}

export { i18next };
