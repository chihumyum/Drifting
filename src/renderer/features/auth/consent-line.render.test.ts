import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LOCALES } from '../../../shared/ui-locales';

type Catalog = { auth: { legal: Record<string, string> } };
const catalog = (locale: string) =>
  JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Catalog;
const language = vi.hoisted(() => ({ legal: {} as Record<string, string> }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      (language.legal[key.replace('auth.legal.', '')] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => options?.[name] ?? ''),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../platform', () => ({ platform: { material: { openExternal: vi.fn() } } }));

import { ConsentLine } from './ConsentLine';

describe('what signing in agrees to', () => {
  it.each(SUPPORTED_LOCALES)('is one line whose terms are the words a hover card hangs on (%s)', (locale) => {
    language.legal = catalog(locale).auth.legal;
    const { consent, consentTerms } = language.legal;
    const [before, after] = consent!.split('{{terms}}');
    const html = renderToStaticMarkup(createElement(ConsentLine));

    expect(Object.keys(language.legal).sort()).toEqual(['consent', 'consentTerms', 'privacy', 'terms']);
    // The sentence is the translation's, with the button exactly where it names the terms.
    expect(html).toBe(
      `<p class="auth-flow__legal">${before}<button type="button" class="auth-flow__consent" aria-expanded="false">${consentTerms}</button>${after}</p>`,
    );
    // The line stays short; the items are not in it until the card opens.
    expect(html).not.toContain('preAlphaGuide.crashReports');
    expect(html).not.toContain('hover-card');
  });
});
