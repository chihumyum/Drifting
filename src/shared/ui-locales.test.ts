import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LOCALES, detectUiLocale, normalizeUiLocale, readInitialUiLocale } from './ui-locales';
import { formatCompactCount, formatRelativeTime } from './locale-format';

afterEach(() => vi.unstubAllGlobals());
describe('interface language selection', () => {
  it.each([
    ['zh-Hant-HK', 'zh-TW'], ['zh-Hans-TW', 'zh-CN'], ['zh_HK', 'zh-TW'], ['zh-MO', 'zh-TW'],
    ['zh-SG', 'zh-CN'], ['en-GB', 'en'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['es-MX', 'es'],
    ['de-AT', 'de'], ['fr-CA', 'fr'], ['pt-PT', 'pt-BR'], ['pt-BR', 'pt-BR'], ['invalid', 'en'],
  ])('resolves %s to %s', (input, expected) => expect(normalizeUiLocale(input)).toBe(expected));
  it('uses all system preferences while retaining explicit saved choices', () => {
    expect(detectUiLocale(['ar', 'fr-CA', 'en'])).toBe('fr');
    expect(detectUiLocale([])).toBe('en');
    vi.stubGlobal('navigator', { languages: ['ko-KR'], language: 'ko-KR' });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ state: { uiLocale: 'zh-TW' } }) });
    expect(readInitialUiLocale()).toBe('zh-TW');
    vi.stubGlobal('localStorage', { getItem: () => '{broken' });
    expect(readInitialUiLocale()).toBe('ko');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('restricted'); } });
    expect(readInitialUiLocale()).toBe('ko');
  });
  it.each(SUPPORTED_LOCALES)('formats time and compact counts in %s', (locale) => {
    expect(formatRelativeTime(0, locale, 120000)).toBe(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-2, 'minute'));
    expect(formatCompactCount(86000, locale)).toBe(new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(86000));
    expect(formatRelativeTime('invalid', locale)).toBe('—');
  });
});
