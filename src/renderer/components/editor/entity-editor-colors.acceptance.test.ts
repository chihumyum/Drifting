import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorPicker } from '../ui/ColorPicker';
import { SettingsColor } from '../../features/settings/SettingsPrimitives';

const runtime = vi.hoisted(() => ({ isMobileShell: false }));
vi.mock('../../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('entity editor custom colours', () => {
  afterEach(() => { runtime.isMobileShell = false; });

  it('uses the accent picker for any six-digit colour, including black and white', () => {
    expect(SettingsColor).toBe(ColorPicker);
    for (const value of ['#123456', '#ABCDEF', '#000000', '#ffffff']) {
      const html = renderToStaticMarkup(createElement(ColorPicker, {
        value, onChange: () => {}, ariaLabel: 'Custom color',
      }));
      expect(html).toContain('type="color"');
      expect(html).toContain(`value="${value.toLowerCase()}"`);
      expect(html).toContain(value.toUpperCase());
      expect(html).toContain('aria-label="Custom color"');
      expect(html).toContain('ui-swatch glass glass--rest glass--round');
    }
  });

  it('does not pass a theme token as the native hex value and keeps mobile operable', () => {
    for (const mobile of [false, true]) {
      runtime.isMobileShell = mobile;
      const html = renderToStaticMarkup(createElement(ColorPicker, {
        value: 'hsl(var(--story-1))', onChange: () => {}, ariaLabel: 'Custom color',
      }));
      expect(html).toContain('color:hsl(var(--story-1))');
      expect(html).not.toContain('value="hsl(');
      expect(html).toContain('type="color"');
      expect(html).toContain('Custom color</span>');
      if (mobile) expect(html).toContain('set-color-picker__input');
    }
  });

  it('can show only the colour control without visible hex or a custom-colour heading', () => {
    for (const value of ['#123456', 'hsl(var(--story-1))']) {
      const html = renderToStaticMarkup(createElement(ColorPicker, {
        value, onChange: () => {}, ariaLabel: 'Custom color', showValue: false,
      }));
      expect(html).toContain('aria-label="Custom color"');
      expect(html).not.toContain('ui-swatch__value');
      expect(html).not.toContain('Custom color</span>');
      expect(html).not.toContain('title=');
    }
  });

  it('keeps presets and writes custom colours through each editor’s existing commit path', () => {
    for (const locale of ['zh-CN', 'en']) {
      expect(JSON.parse(source(`src/renderer/locales/${locale}.json`)).common.customColor).toBeTruthy();
    }
    for (const [file, color] of [
      ['StorylineEditorView', 'storylineColor'],
      ['CategoryEditorView', 'categoryColor'],
    ]) {
      const view = source(`src/renderer/views/${file}.tsx`);
      expect(view).toContain('hsl(var(--story-6))');
      expect(view).toContain('onClick={() => void commitColor(c)}');
      expect(view).toContain(`<ColorPicker\n                          value={${color}}`);
      expect(view).toContain('onChange={(color) => void commitColor(color)}');
      expect(view).toContain("ariaLabel={t('common.customColor')}");
      expect(view).toContain('showValue={false}');
    }
    const css = source('src/styles/entity-editors.css');
    expect(css).toMatch(/\.col-pick \{[^}]*flex-wrap: wrap;/);
  });
});
