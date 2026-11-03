import { createInstance } from 'i18next';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import es from '../locales/es.json';
import de from '../locales/de.json';
import fr from '../locales/fr.json';
import ptBR from '../locales/pt-BR.json';

export const UI_TRANSLATIONS = {
  'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko, es, de, fr, 'pt-BR': ptBR,
};


/** Non-React consumers (tool cards, permissions) use explicit locales. */
export const uiTranslator = createInstance();
void uiTranslator.init({
  resources: Object.fromEntries(Object.entries(UI_TRANSLATIONS).map(([code, translation]) => [code, { translation }])),
  lng: 'en', fallbackLng: 'en', initAsync: false,
  interpolation: { escapeValue: false }, returnNull: false,
});
