import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ isMobileShell: false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));
vi.mock('../../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));

import { designSystemDocs } from '../../components/design-system-docs.test-support';
import { GlassRange } from '../../components/ui/GlassRange';
import {
  SettingsButton,
  SettingsColor,
  SettingsConfigField,
  SettingsField,
  SettingsNote,
  SettingsPanelHeader,
  SettingsSectionHeader,
  SettingsSelect,
} from './SettingsPrimitives';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const html = (element: ReactElement) => renderToStaticMarkup(element);

const FEW = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];
const MANY = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value.toUpperCase() }));

describe('settings in sand and glass on the desktop', () => {
  beforeEach(() => {
    runtime.isMobileShell = false;
  });

  it('draws the settings controls with the shared controls of components.md', () => {
    expect(html(createElement(SettingsButton, {}, 'Save'))).toContain('ui-button--glass');
    expect(html(createElement(SettingsButton, { variant: 'danger' }, 'Delete'))).toContain('ui-button--danger');
    const outbound = html(createElement(SettingsButton, { outbound: true }, 'Open'));
    expect(outbound).toContain('ui-button--ghost');
    expect(outbound).toContain('brush-icon--arrow-out');

    const field = html(createElement(SettingsField, { mono: true, small: true, meta: 'px', 'aria-label': 'Key' }));
    expect(field).toContain('class="ui-field glass glass--rest glass--field glass--small ui-field--mono ui-field--sm"');
    expect(field).toContain('<span class="ui-field__meta">px</span>');
    expect(html(createElement(SettingsConfigField, { 'aria-label': 'Env' }))).toContain('ui-field--config');

    // Four or fewer short options slide; longer lists open a GlassSelect.
    const props = { value: 'a', onChange: () => undefined, ariaLabel: 'Choice' };
    expect(html(createElement(SettingsSelect, { ...props, few: true, options: FEW }))).toContain('class="glass-slider"');
    expect(html(createElement(SettingsSelect, { ...props, options: MANY }))).toContain('ui-select glass glass--rest glass--field glass--small');

    const note = html(createElement(SettingsNote, { icon: 'status-stopped', tone: 'error', children: 'Failed' }));
    expect(note).toContain('class="set-note set-note--error"');
    expect(note).toContain('brush-icon--status-stopped');

    const swatch = html(createElement(SettingsColor, { value: '#a1b2c3', onChange: () => undefined, ariaLabel: 'Accent' }));
    expect(swatch).toContain('class="ui-swatch glass glass--rest glass--round"');
    expect(swatch).toContain('<span class="ui-swatch__value">#A1B2C3</span>');

    const range = html(createElement(GlassRange, { value: 5, min: 0, max: 10, onChange: () => undefined, ariaLabel: 'Size' }));
    expect(range).toContain('class="ui-range"');
    expect(range).toContain('--range-p:0.5');
    expect(range).toContain('class="ui-range__halo glass glass--round"');

    // No accent kicker and no English hint repeating the title.
    expect(html(createElement(SettingsPanelHeader, { kicker: 'KICKER', title: 'Title' }))).not.toContain('set-panel__kicker');
    expect(html(createElement(SettingsSectionHeader, { title: 'Theme', hint: 'THEME' }))).not.toContain('THEME');
  });

  it('keeps the older set-* controls in the paused mobile shell', () => {
    runtime.isMobileShell = true;
    expect(html(createElement(SettingsButton, { variant: 'primary' }, 'Save'))).toContain('class="set-btn set-btn--primary"');
    expect(html(createElement(SettingsField, { mono: true }))).toContain('class="set-input set-input--mono"');
    const select = html(createElement(SettingsSelect, { value: 'a', onChange: () => undefined, ariaLabel: 'Choice', few: true, options: FEW }));
    expect(select).toContain('<select class="set-input"');
    expect(html(createElement(SettingsColor, { value: '#a1b2c3', onChange: () => undefined, ariaLabel: 'Accent' }))).toContain(
      'set-color-picker__input',
    );
    expect(html(createElement(SettingsPanelHeader, { kicker: 'KICKER', title: 'Title' }))).toContain('set-panel__kicker');
    expect(html(createElement(SettingsSectionHeader, { title: 'Theme', hint: 'THEME' }))).toContain('THEME');
  });

  it('draws the provider row, shortcuts, trash and about as their new definitions', () => {
    const intelligence = source('src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx');
    expect(intelligence).toContain('className="set-provider-line"');
    expect(intelligence).toContain("kind-mark--chapter${live ? '' : ' kind-mark--hollow'}");
    // A dev .env key still reads as connected and still has nothing to disconnect.
    expect(intelligence).toContain("source={live ? (connected ? 'Keychain' : '.ENV (DEV)')");
    expect(intelligence).toMatch(/\{connected && \(\s*<SettingsButton variant="danger" size="sm" onClick=\{disconnect\}>/);
    // Test results: a brush icon and a sentence, the danger ink when it failed.
    expect(intelligence).toContain("className={`set-provider-result${tone === 'error' ? ' set-provider-result--error' : ''}`}");
    expect(intelligence.split('settingsOnDesktop()').length).toBeGreaterThan(2);

    const controls = source('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    expect(controls).toContain("className={`set-key-combo glass glass--small${isRecording ? ' glass--waiting' : ''}`}");
    expect(controls).toContain('<div className="set-about-name__title">Drifting</div>');
    expect(controls).not.toContain('cnName');

    const trash = source('src/renderer/components/TrashPanel.tsx');
    expect(trash).toContain('className="set-trash__row menu-surface__item"');
    expect(trash).toContain('<KindMark kind={it.kind} seed={it.id}');

    // Drifting has no Chinese name.
    for (const locale of ['zh-CN', 'en']) {
      const about = JSON.parse(source(`src/renderer/locales/${locale}.json`)).settings.about;
      expect(about.cnName).toBeUndefined();
      expect(about.title).toBe('Drifting');
    }
  });

  it('keeps the desktop section flat: no washes, gradients, dotted rules or side shadows', () => {
    const css = source('src/styles/settings.css');
    const desktop = css.slice(css.indexOf('Desktop: sand and plain glass'));
    expect(desktop.length).toBeGreaterThan(1000);
    expect(desktop).not.toMatch(/linear-gradient|dotted|hsl\(var\(--ink-1\) \/ 0\.0|hsl\(var\(--accent\) \/ 0\./);
    expect(desktop).toMatch(/\.set-rail \{[\s\S]*?border-right: 0\.5px solid var\(--workspace-local-border\);[\s\S]*?box-shadow: none;/);
    expect(desktop).toMatch(/\.set-preview \{[\s\S]*?box-shadow: var\(--page-elevation\);/);
    expect(desktop).toMatch(/\.set-rail__item\.is-current::before[\s\S]*?animation-play-state: paused;/);
    expect(desktop).not.toContain('-132px');

    const controls = source('src/styles/ui-controls.css');
    expect(controls).toContain('.ui-field--mono > input');
    expect(controls).toContain('.ui-field--config {');
    expect(controls).toContain('.ui-range:active .ui-range__halo {');
    expect(controls).toContain('.ui-swatch > input[type=\'color\'] {');
  });

  it('documents the new definitions', () => {
    const docs = designSystemDocs();
    for (const name of ['数值滑块', '色板', '字体选择', '服务商连接行', '快捷键组合', '配置框']) {
      expect(docs, name).toContain(`**${name}**`);
    }
    expect(docs).toContain('当前位置是静止的选中环');
  });
});
