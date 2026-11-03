import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { normalizeUiLocale, readInitialUiLocale } from '../../shared/ui-locales';

export { SUPPORTED_LOCALES, UI_LOCALE_OPTIONS } from '../../shared/ui-locales';
export type { SupportedLocale } from '../../shared/ui-locales';

import { UI_TRANSLATIONS } from './locale-resources';
export { UI_TRANSLATIONS } from './locale-resources';

void i18next
  .use(initReactI18next)
  .init({
    resources: Object.fromEntries(Object.entries(UI_TRANSLATIONS).map(([code, translation]) => [code, { translation }])),
    lng: readInitialUiLocale(),
    fallbackLng: 'en',
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });

function applyDocumentLocale(locale: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = normalizeUiLocale(locale);
  document.documentElement.dir = 'ltr';
}
applyDocumentLocale(i18next.language);
i18next.on('languageChanged', applyDocumentLocale);

export function setI18nLocale(locale: string): void {
  void i18next.changeLanguage(normalizeUiLocale(locale));
}

export { i18next };
