import type { i18n as I18n } from 'i18next';
import zhCN from '../locales/windows/zh-CN.json';
import zhTW from '../locales/windows/zh-TW.json';
import en from '../locales/windows/en.json';
import ja from '../locales/windows/ja.json';
import ko from '../locales/windows/ko.json';
import es from '../locales/windows/es.json';
import de from '../locales/windows/de.json';
import fr from '../locales/windows/fr.json';
import ptBR from '../locales/windows/pt-BR.json';

/**
 * The interface languages name the Mac's own things: "this Mac", Finder,
 * Keychain, the Apple Silicon build. On Windows the same keys read "this PC",
 * File Explorer and Windows Credential Manager. Only keys whose wording
 * differs live here; every other string is shared. See docs/windows.md.
 */
export const WINDOWS_TRANSLATIONS = {
  'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko, es, de, fr, 'pt-BR': ptBR,
};

/** Overlay the platform's wording before the first render. Apple platforms keep the base strings. */
export function applyPlatformCopy(instances: readonly I18n[], nativePlatform: string): void {
  if (nativePlatform !== 'windows') return;
  for (const instance of instances) {
    for (const [locale, overrides] of Object.entries(WINDOWS_TRANSLATIONS)) {
      instance.addResourceBundle(locale, 'translation', overrides, true, true);
    }
  }
}
