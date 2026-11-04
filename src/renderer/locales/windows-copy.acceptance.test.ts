import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { UI_TRANSLATIONS } from '../lib/locale-resources';
import { WINDOWS_TRANSLATIONS, applyPlatformCopy } from '../lib/platform-copy';
import { SUPPORTED_LOCALES } from '../../shared/ui-locales';

const flatten = (object: object, prefix = ''): [string, string][] => Object.entries(object).flatMap(([key, value]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  return typeof value === 'string' ? [[path, value]] : flatten(value as object, path);
});
const tokens = (text: string) => [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]).sort();

/** Names of the Mac's own things, in every interface language. */
const MAC_WORDING = /\bMac\b|Macs\b|macOS|Apple Silicon|Finder|Keychain|访达|钥匙串|鑰匙圈|キーチェーン|키체인|llavero|Schlüsselbund|trousseau|chaveiro/u;

describe('Windows wording (docs/windows.md)', () => {
  const englishKeys = flatten(WINDOWS_TRANSLATIONS.en).map(([key]) => key).sort();

  it.each(SUPPORTED_LOCALES)('%s overrides the same keys, keeps interpolation and names no Mac things', (locale) => {
    const overrides = flatten(WINDOWS_TRANSLATIONS[locale]);
    const base = new Map(flatten(UI_TRANSLATIONS[locale]));
    expect(overrides.map(([key]) => key).sort()).toEqual(englishKeys);
    for (const [key, value] of overrides) {
      const original = base.get(key);
      expect(original, `${locale}:${key}`).toBeDefined();
      expect(tokens(value), `${locale}:${key}`).toEqual(tokens(original!));
      expect(value, `${locale}:${key}`).not.toMatch(MAC_WORDING);
      expect(value.trim(), `${locale}:${key}`).not.toBe('');
    }
  });

  it.each(SUPPORTED_LOCALES)('every %s string that names a Mac thing has Windows wording', (locale) => {
    const covered = new Set(flatten(WINDOWS_TRANSLATIONS[locale]).map(([key]) => key));
    const uncovered = flatten(UI_TRANSLATIONS[locale])
      .filter(([key, value]) => MAC_WORDING.test(value) && !covered.has(key))
      .map(([key]) => key);
    expect(uncovered).toEqual([]);
  });

  it('applies on Windows only', async () => {
    const make = async () => {
      const instance = createInstance();
      await instance.init({
        lng: 'zh-CN', fallbackLng: 'en', initAsync: false,
        resources: Object.fromEntries(Object.entries(UI_TRANSLATIONS).map(([code, translation]) => [code, { translation }])),
      });
      return instance;
    };
    const mac = await make();
    applyPlatformCopy([mac], 'macos');
    expect(mac.t('settings.sync.projection.reveal')).toBe('在访达中打开');
    const windows = await make();
    applyPlatformCopy([windows], 'windows');
    expect(windows.t('settings.sync.projection.reveal')).toBe('在文件资源管理器中打开');
    expect(windows.t('auth.signOut.uploading', { count: 3 })).toBe('正在把这台电脑上的改动传上去，还剩 3 条。');
    await windows.changeLanguage('en');
    expect(windows.t('settings.update.channel_desc')).toBe('Windows 10/11 · x64 and ARM64');
    expect(windows.t('userMenu.settings')).toBe(mac.getFixedT('en')('userMenu.settings'));
  });
});
