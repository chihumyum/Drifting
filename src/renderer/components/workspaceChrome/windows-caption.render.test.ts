import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

const runtime = vi.hoisted(() => ({ isWindowsDesktop: true }));
vi.mock('../../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));
vi.mock('../../platform', () => ({
  platform: { window: { close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), isMaximized: vi.fn() } },
}));

import { WindowsCaption } from './WindowsCaption';

const root = resolve(import.meta.dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

/** The CSS rule block for a selector, as written. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start) + 1);
}

describe('Windows window buttons (docs/windows.md)', () => {
  it('draws close, minimize and maximize in one glass pill, in the traffic lights order', () => {
    const html = renderToStaticMarkup(createElement(WindowsCaption));
    expect(html).toContain('class="windows-caption glass glass--rest"');
    expect(html).toContain('aria-label="windowCaption.label"');
    const order = [...html.matchAll(/aria-label="(windowCaption\.[a-z]+)"/gu)].map((match) => match[1]);
    expect(order).toEqual(['windowCaption.label', 'windowCaption.close', 'windowCaption.minimize', 'windowCaption.maximize']);
    expect(html.match(/class="windows-caption__button[^"]* glass glass--round"/gu)).toHaveLength(3);
    for (const icon of ['close', 'minus', 'window-max']) expect(html).toContain(`brush-icon--${icon}`);
  });

  it('draws nothing where the platform keeps its own window buttons', () => {
    runtime.isWindowsDesktop = false;
    try {
      expect(renderToStaticMarkup(createElement(WindowsCaption))).toBe('');
    } finally {
      runtime.isWindowsDesktop = true;
    }
  });

  it('is the paper toolbar tray without a fill, in the top-left corner above dialogs', () => {
    const css = read('src/styles/desktop-shell.css');
    const pill = rule(css, '.windows-caption');
    expect(pill).toContain('position: fixed;');
    expect(pill).toContain('left: 8px;');
    expect(pill).toContain('background: transparent;');
    expect(pill).not.toMatch(/backdrop-filter|--glass-fill/u);
    expect(pill).toContain('padding: var(--glass-tray-padding);');
    expect(pill).toContain('gap: 2px;');
    expect(pill).toContain('--glass-rim: 12px;');
    expect(pill).toContain('z-index: calc(var(--z-modal) + 40);');
    const button = rule(css, '.windows-caption__button');
    expect(button).toContain('width: var(--glass-round-size);');
    expect(button).toContain('border-radius: 50%;');
    expect(rule(css, '.windows-caption__button > .brush-icon')).toContain('width: var(--glass-round-icon);');
    expect(rule(css, '.windows-caption__button--close:hover')).toContain('--glass-cc: hsl(var(--destructive));');
    // Headers and the left toggle leave the pill clear, as they do the traffic lights.
    expect(rule(css, "html[data-native-platform='windows']")).toContain('--window-header-leading-inset: 110px;');
    expect(css).toContain("body:has(.desktop-app-shell[data-immersive]) .windows-caption {");
    expect(css).toContain("body:has(.desktop-app-shell[data-immersive][data-immersive-peek='top']) .windows-caption {");
  });

  it('keeps Drifting in the notification area when the shelf closes on Windows', () => {
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toMatch(/#\[cfg\(any\(target_os = "macos", target_os = "windows"\)\)\]\s+let _ = window\.hide\(\);/u);
    expect(lib).toMatch(/#\[cfg\(target_os = "windows"\)\]\s+windows_tray::install\(app\.handle\(\)\)\?;/u);
    expect(lib).toContain('windows_tray::tray_set_labels,');
    const tray = read('src-tauri/src/windows_tray.rs');
    expect(tray).toContain('crate::request_flushed_shutdown(app, crate::state::ShutdownAction::ExitApp)');
    expect(tray).toContain('.show_menu_on_left_click(false)');
    expect(read('src-tauri/Cargo.toml')).toContain('tauri = { version = "2.11.5", features = ["tray-icon"] }');
    const effects = read('src/renderer/app/effects/AppEffects.tsx');
    expect(effects).toContain("setTrayLabels({ open: t('windowCaption.trayOpen'), quit: t('windowCaption.trayQuit') })");
  });

  it('turns the native title bar off on Windows only, and mounts the pill at the app root', () => {
    expect(read('src-tauri/src/windows_webview.rs')).toContain('window.set_decorations(false)?;');
    expect(read('src-tauri/src/lib.rs')).toMatch(/#\[cfg\(target_os = "windows"\)\]\s+windows_webview::configure\(&window\)\?;/u);
    expect(read('src/renderer/App.tsx')).toContain('<WindowsCaption />');
    for (const file of [
      'src/renderer/components/workspaceChrome/WindowControlButtons.tsx',
      'src/renderer/components/leftBars/LeftSidebarHeader.tsx',
      'src/renderer/components/SuperViewHeader.tsx',
    ]) {
      expect(read(file), file).toContain('leadingWindowControls');
    }
  });
});
