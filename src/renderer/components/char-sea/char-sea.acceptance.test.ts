import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

const sea = vi.hoisted(() => ({ enabled: true, holds: [] as string[] }));
vi.mock('./useCharSea', () => ({
  useCharSeaEnabled: () => sea.enabled,
  useCharSeaHold: (kind: string, on: boolean) => { if (on) sea.holds.push(kind); },
}));

import { FullScreenStatus } from '../../app/components/FullScreenStatus';

const root = resolve(import.meta.dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('the sea of characters under the desktop window', () => {
  it('opens on the sea at rest: the desk with a faint dot in every 14px cell, no spinner', () => {
    const html = read('index.html');
    const placeholder = block(html, '#app-startup-loading {', '</style>');
    expect(html).toContain('<div id="app-startup-loading" role="status" aria-label="正在启动 Drifting" data-tauri-drag-region></div>');
    expect(placeholder).not.toMatch(/@keyframes|animation/);
    expect(placeholder).toContain('background-size: 14px 14px;');
    expect(placeholder).toContain('background-position: center;');
    // The desk's own colour (--paper-deep), light and dark, so React takes over without a change of ground.
    const tokens = read('src/styles/index.css');
    expect(tokens).toContain('--paper-deep: 40 9% 94.5%;');
    expect(tokens).toContain('--paper-deep: 220 6% 11.5%;');
    expect(placeholder).toContain('background-color: hsl(40 9% 94.5%);');
    expect(placeholder).toContain('background-color: hsl(220 6% 11.5%);');
    const css = read('src/styles/char-sea.css');
    expect(block(css, '.char-sea {', '}')).toMatch(/z-index: -1;[\s\S]*background-color: var\(--workspace-ui-bg\);[\s\S]*background-position: center;[\s\S]*background-size: 14px 14px;/);
  });

  it('turns a full-window wait into the sea on the desktop, keeping the words for screen readers', () => {
    sea.enabled = true;
    sea.holds = [];
    const waiting = renderToStaticMarkup(createElement(FullScreenStatus, { title: '正在打开项目…', detail: '正在读取项目内容…', loading: true }));
    expect(waiting).toContain('app-fullscreen-status--sea');
    expect(waiting).toContain('<span class="sr-only">正在打开项目… 正在读取项目内容…</span>');
    expect(waiting).not.toContain('app-fullscreen-status__spinner');
    expect(sea.holds).toEqual(['loading']);

    sea.holds = [];
    const failed = renderToStaticMarkup(createElement(FullScreenStatus, {
      title: '无法打开这个项目', loading: false, action: { label: '重试', onClick: () => undefined },
    }));
    expect(failed).not.toContain('app-fullscreen-status--sea');
    expect(sea.holds).toEqual([]);

    sea.enabled = false;
    const mobile = renderToStaticMarkup(createElement(FullScreenStatus, { title: '正在打开项目…', loading: true }));
    expect(mobile).toContain('app-fullscreen-status__spinner');
  });

  it('mounts once at the root on the desktop, and the shelf lies on it', () => {
    const app = read('src/renderer/App.tsx');
    expect(app).toContain('const [seaEnabled] = useState(charSeaEnabled);');
    expect(app).toContain('{seaEnabled && <CharSea />}');
    const hooks = read('src/renderer/components/char-sea/useCharSea.ts');
    expect(hooks).toContain("return !getPlatformRuntime().isMobileShell && charSeaSupported();");

    const shelf = read('src/renderer/views/ProjectPickerView.tsx');
    expect(shelf).toContain("useCharSeaHold('surface', onSea);");
    expect(shelf).toContain("const shelfClass = onSea ? 'pp pp--sea' : 'pp';");
    expect(shelf).toContain('const { attach: glassRef, drawn: seaDrawn, hoverProps: glassHover } = useCharSeaShape<HTMLElement>({ rest: 0.85, radius: 2 });');
    expect(shelf).toContain("className={`pp-card glass glass--rest${seaDrawn ? ' pp-card--sea' : ''}`}");
    expect(shelf).toContain('data-char-sea-press=""');
    expect(shelf).toContain('const { attach: newSlipRef } = useCharSeaShape<HTMLDivElement>({ rest: 0, radius: 2, hover: false });');
    const picker = read('src/styles/project-picker.css');
    expect(block(picker, '.pp--sea {', '}')).toContain('background: transparent;');
    expect(block(picker, '.pp-card--sea.glass::before {', '}')).toContain('display: none;');
  });

  it('drops from the press that started a wait, after the loading delay, and stops when still', () => {
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    expect(component).toContain('const PULSE_PERIOD_MS = 1100;');
    expect(component).toContain('}, LOADING_DELAY_MS);');
    expect(component).toContain('charSeaRegistry.recentPress(PRESS_ORIGIN_MS)');
    expect(component).toContain("const OVERLAY = '[role=\"dialog\"], [aria-modal=\"true\"], [role=\"menu\"], [role=\"listbox\"]';");
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    // Still water and still glass draw one last frame, then nothing.
    expect(engine).toContain('if (quietFrames > 20) {');
    expect(engine).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')");
    // The rim is the app's resting glass: 1px of glass-clear at 33% × 1.8, cut by the same texture and tile.
    expect(engine).toContain("import glassTextureUrl from '../../../assets/design/glass-thick.png';");
    expect(engine).toContain('const GLASS_EDGE = 0.594;');
    expect(engine).toContain('const GLASS_TILE = 150;');
    // The line itself never moves: only its thickness and depth follow the water.
    expect(engine).toContain('float sd=sdBox(px,R,P.x);');
  });

  it('is written down in the design system', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('全屏加载与字海');
    expect(docs).toContain('`CharSea`');
    expect(read('docs/renderer-performance/startup-placeholder.md')).toContain('字海');
  });
});
