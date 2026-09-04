import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe('mobile Editor Settings presentation', () => {
  it('reuses desktop preference state and the same live editor variables', () => {
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    const panel = read('src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx');
    const settingsCss = read('src/styles/settings.css');

    expect(mobile).toContain("case 'editor':");
    expect(mobile).toContain('<EditorPanel registerRef={REGISTER_NOOP} />');
    expect(panel).toContain("'--set-mobile-preview-width'");
    expect(panel).toContain('((maxLineWidth - 480) / (1280 - 480)) * 22');
    expect(settingsCss).toContain('font-size: var(--editor-font-size');
    expect(settingsCss).toContain('line-height: var(--editor-line-height');
    expect(settingsCss).toContain('var(--editor-paragraph-spacing');
    expect(settingsCss).toContain('text-indent: var(--editor-indent');
    expect(settingsCss).toContain('var(--editor-indent-step');
  });

  it('removes desktop rail geometry and keeps the phone preview horizontal', () => {
    const css = read('src/styles/mobile-settings.css');
    const preview = cssBlock(css, '.m-settings__content #editor .set-preview');

    expect(preview).toContain('width: min(100%, var(--set-mobile-preview-width, 100%));');
    expect(preview).toContain('max-width: 100%;');
    expect(preview).toContain('margin: 4px auto 0;');
    expect(preview).toContain('transform: none;');
    expect(preview).toContain('writing-mode: horizontal-tb;');
    expect(preview).toContain('word-break: normal;');
    expect(preview).not.toContain('100vw - 320px');
  });

  it('makes typography controls full-width and touch-sized without changing desktop CSS', () => {
    const css = read('src/styles/mobile-settings.css');
    const slider = cssBlock(css, ".m-settings__content #editor .set-slider input[type='range']");
    const segment = cssBlock(css, '.m-settings__content #editor .segmented-control__option');
    const fontTool = cssBlock(css, '.m-settings__content #editor .set-font-tool');

    expect(slider).toContain('width: 100% !important;');
    expect(slider).toContain('min-height: 44px;');
    expect(slider).toContain('touch-action: pan-y;');
    expect(segment).toContain('flex: 1 1 0;');
    expect(segment).toContain('min-height: 44px;');
    expect(segment).toContain('white-space: normal;');
    expect(fontTool).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(css).toContain('.m-settings__content #editor .set-font-tool__select');
    expect(css).toContain('width: 100%;');
  });

  it('records the live preview and physical-device acceptance boundary', () => {
    const foundation = read('docs/mobile-ui-foundation.md');
    const acceptance = read('docs/mobile-device-acceptance.md');

    expect(foundation).toContain('mobile Editor Settings');
    expect(foundation).toContain('scaled');
    expect(acceptance).toContain('示例正文必须保持横排且可读');
    expect(acceptance).toContain('至少 44px 的触控高度');
  });
});
