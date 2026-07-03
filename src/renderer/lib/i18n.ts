import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../locales/zh-CN.json';
import en from '../locales/en.json';

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const UI_LOCALE_OPTIONS: { code: SupportedLocale; name: string; native: string }[] = [
  { code: 'zh-CN', name: '中文（简体）', native: '中文' },
  { code: 'en', name: 'English', native: 'English' },
];

function normalizeUiLocale(locale: string | null | undefined): SupportedLocale {
  if (locale === 'zh-CN' || locale?.startsWith('zh')) return 'zh-CN';
  return 'en';
}

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
      if (persisted) return normalizeUiLocale(persisted);
    }
  } catch {
    // ignore — fall through to system detection
  }
  const nav = (navigator.language ?? 'en') as string;
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

void i18next
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    lng: getInitialLocale(),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export function setI18nLocale(locale: string): void {
  void i18next.changeLanguage(normalizeUiLocale(locale));
}

export { i18next };
