import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { UI_TRANSLATIONS } from '../lib/i18n';
import { SUPPORTED_LOCALES } from '../../shared/ui-locales';
import { describeAgentPermissionAction, describeAgentToolActivity } from '../lib/agent/agent-tool-activity';

const flatten = (object: object, prefix = ''): [string, string][] => Object.entries(object).flatMap(([key, value]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  return typeof value === 'string' ? [[path, value]] : flatten(value, path);
});
const tokens = (text: string) => [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]).sort();
const canonical = (key: string) => key.replace(/_(?:one|other|many)$/u, '');

describe('nine interface languages', () => {
  it.each(SUPPORTED_LOCALES)('%s has complete resources and intact interpolation', (locale) => {
    const source = new Map(flatten(UI_TRANSLATIONS[locale === 'zh-CN' ? 'zh-CN' : 'en']));
    const values = new Map(flatten(UI_TRANSLATIONS[locale]));
    expect([...new Set([...values.keys()].map(canonical))].sort()).toEqual([...new Set([...source.keys()].map(canonical))].sort());
    for (const [key, value] of values) {
      const original = source.get(key) ?? source.get(key.replace(/_many$/u, '_other'));
      expect(original, key).toBeDefined();
      if (original!.trim()) expect(value.trim(), `${locale}:${key}`).not.toBe('');
      else expect(value).toBe(original);
      expect(tokens(value), `${locale}:${key}`).toEqual(tokens(original!));
      expect(value, key).not.toMatch(/900000\d\d|▁|<unk>/u);
    }
  });
  it.each(SUPPORTED_LOCALES)('%s resolves plural counts without fallback', async (locale) => {
    const instance = createInstance();
    await instance.init({ lng: locale, fallbackLng: false, resources: { [locale]: { translation: UI_TRANSLATIONS[locale] } } });
    for (const count of [0, 1, 2, 5, 1000000]) {
      for (const key of ['manuscriptExport.chapterCount', 'agentActivity.unviewedChangeCount', 'projectPicker.desk.chaptersUnit']) {
        expect(instance.t(key, { count })).not.toBe(key);
      }
    }
  });
  it.each(SUPPORTED_LOCALES)('%s translates Agent progress without changing authored targets', (locale) => {
    const target = 'Synthetic ⟨雨⟩ 42';
    const activity = describeAgentToolActivity('read_chapter', { chapter: target }, locale);
    expect(activity).toContain(target);
    expect(activity).not.toMatch(/agentTools\./u);
    const permission = describeAgentPermissionAction('create_relation', { fromType: 'chapter', fromName: target, toType: 'element', toName: 'Synthetic Ω', relationType: 'Custom relation' }, locale);
    expect(permission?.summary).toContain('Custom relation');
    expect(permission?.summary).toContain(target);
    expect(permission?.summary).toContain('Synthetic Ω');
    expect(describeAgentToolActivity('unknown_tool', {}, locale)).toBeNull();
  });
  it.each([...SUPPORTED_LOCALES, 'zh-Hant-HK', 'es-MX', 'pt-PT'])('bootstrap and runtime agree on %s', (saved) => {
    const root = { classList: { toggle: () => {} }, dataset: {}, style: {}, lang: '', dir: '' };
    let label = '';
    const storage = { getItem: () => JSON.stringify({ state: { uiLocale: saved } }) };
    vm.runInNewContext(readFileSync('public/startup.js', 'utf8'), {
      document: { documentElement: root, getElementById: () => ({ setAttribute: (_key: string, value: string) => { label = value; } }) },
      window: { localStorage: storage, matchMedia: () => ({ matches: false }) }, localStorage: storage,
      navigator: { languages: ['en'], language: 'en' },
    });
    const expected = saved === 'zh-Hant-HK' ? 'zh-TW' : saved === 'es-MX' ? 'es' : saved === 'pt-PT' ? 'pt-BR' : saved;
    expect(root.lang).toBe(expected);
    expect(root.dir).toBe('ltr');
    expect(label).toBe(UI_TRANSLATIONS[expected as keyof typeof UI_TRANSLATIONS].startup.loading);
  });
});
