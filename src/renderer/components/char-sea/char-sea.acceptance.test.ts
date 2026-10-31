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
  it('opens on the sea at rest: the desk with a faint dot in every 10px cell, no spinner', () => {
    const html = read('index.html');
    const placeholder = block(html, '#app-startup-loading {', '</style>');
    expect(html).toContain('<div id="app-startup-loading" role="status" aria-label="正在启动 Drifting" data-tauri-drag-region></div>');
    expect(placeholder).not.toMatch(/@keyframes|animation/);
    expect(placeholder).toContain('background-size: 10px 10px;');
    expect(placeholder).toContain('background-position: center;');
    // The desk's own colour (--paper-deep), light and dark, so React takes over without a change of ground.
    const tokens = read('src/styles/index.css');
    expect(tokens).toContain('--paper-deep: 40 9% 94.5%;');
    expect(tokens).toContain('--paper-deep: 220 6% 11.5%;');
    expect(placeholder).toContain('background-color: hsl(40 9% 94.5%);');
    expect(placeholder).toContain('background-color: hsl(220 6% 11.5%);');
    const css = read('src/styles/char-sea.css');
    expect(block(css, '.char-sea {', '}')).toMatch(/z-index: -1;[\s\S]*background-color: var\(--workspace-ui-bg\);[\s\S]*background-position: center;[\s\S]*background-size: 10px 10px;/);
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

  it('lays the first-run choice in the window on the sea, in the rain with no word', () => {
    const routes = read('src/renderer/app/AppRoutes.tsx');
    expect(routes).toMatch(/<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>\s*<\/PreAlphaFirstRunGate>/);
    const gate = block(
      read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx'),
      'export function PreAlphaFirstRunGate',
      '\n}\n',
    );
    // Not a dialog over the window but a card in it, whose resting glass the sea draws.
    expect(gate).not.toMatch(/ModalRoot|ModalCard|aria-modal/);
    expect(gate).toContain(
      'const { attach: cardRef, drawn: onSea } = useCharSeaShape<HTMLElement>({ rest: 0.85, radius: 2, hover: false });',
    );
    expect(gate).toContain("useCharSeaHold('rain', open && onSea);");
    expect(gate).toContain("glass glass--rest glass--still${onSea ? ' first-run-gate__card--sea' : ''}");
    expect(gate).toContain("<div className={`first-run-gate${onSea ? ' first-run-gate--sea' : ''}`}>");
    const css = read('src/styles/auth.css');
    expect(block(css, '.first-run-gate {', '}')).toContain('background: var(--workspace-ui-bg);');
    expect(block(css, '.first-run-gate--sea {', '}')).toContain('background: transparent;');
    expect(block(css, '.first-run-gate__card--sea.glass::before {', '}')).toContain('display: none;');
    // A card that steps through a flow takes its drawn rim with it.
    expect(read('src/renderer/components/char-sea/useCharSea.ts')).toContain(
      'new ResizeObserver(() => charSeaRegistry.resized())',
    );

    // Rain holds the sea live and falls at once; the word belongs to a wait, which hands its rain over.
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    expect(component).toContain('const held = holds.loading > 0 || holds.rain > 0 || holds.surfaces > 0;');
    expect(component).toContain('sea.current?.rain(true);');
    expect(component).toContain('return () => sea.current?.rain(false);');
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    const rain = block(engine, '    rain(on) {', '    setShapes(next) {');
    expect(rain).toContain('rain?.start();');
    expect(rain).not.toMatch(/water\.hold|word\.held = true/);
    expect(rain).toContain('if (!word.held) rain?.stop();');
    expect(engine).toContain('if (!rainHeld) rain?.stop();');
  });

  it('rains and raises "Loading" out of the water after the loading delay, lets both go when the wait ends, and stops when still', () => {
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    expect(component).toContain('const timer = window.setTimeout(() => sea.current?.loading(true), LOADING_DELAY_MS);');
    expect(component).toContain('sea.current?.loading(false);');
    expect(component).not.toContain('pulse');
    expect(component).toContain("const OVERLAY = '[role=\"dialog\"], [aria-modal=\"true\"], [role=\"menu\"], [role=\"listbox\"]';");
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    // The word is water held to its shape in an old serif; the sheet's own characters surface on it.
    expect(engine).toContain("const LOADING_WORD = 'Loading';");
    expect(engine).toContain('`700 ${size}px "Times New Roman", Tinos, Times, serif`');
    expect(engine).toContain('water.hold(wordShape);');
    // Its standing slope moves no glyph, no light or shade is painted round it,
    // and the rain surfaces a cell to 70% of a crest.
    expect(engine).toContain('-uWordH*vec2(wAt(cc+sx)-wAt(cc-sx),wAt(cc+sy)-wAt(cc-sy));');
    expect(engine).not.toMatch(/col\+=vec3/);
    expect(engine).toContain('float s=max(smoothstep(.04,.26,abs(hc)),.7*rd.x);');
    expect(read('src/renderer/lib/char-sea/char-sea-text.ts')).not.toMatch(/cellHeight: 14/);
    // Meanwhile the characters under the rain and in the word change, for letters of the same passage.
    expect(engine).toContain("glyphs.tick(dt, rain?.cells ?? null, word.shown > 0.05 ? wordCells : null);");
    expect(read('src/renderer/lib/char-sea/char-sea-model.ts')).toContain('const SWAP_HEAD = 14;');
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

  it('ebbs under the workspace a wait opened: the rings run out, untouched, then it goes off', () => {
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    // Losing every hold lets it ebb; a hold makes it live again at once.
    expect(component).toContain("if (held && mode !== 'live') setMode('live');");
    expect(component).toContain("if (!held && mode === 'live') setMode('ebb');");
    expect(component).toContain("root.dataset.charSea = 'ebb';");
    expect(component).toContain('if (sea.current) sea.current.ebb(still);');
    expect(component).toContain('const EBB_LIMIT_MS = 8000;');
    // Only a live sea feels the hand.
    expect(component).toContain("if (mode !== 'live') return undefined;");
    // The sidebars and the bottom bar cover it as the cards do; where a ring
    // reaches their outline its glass bleeds as a card's does.
    expect(component).toContain("const EBB_PANELS = '.desktop-app-shell .sidebar-shell:not(.is-fully-hidden), .desktop-app-shell .desktop-workspace-dock';");
    expect(component).toContain('radius: 0, rest: 0, hover: false, textureX, textureY,');
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    expect(engine).toContain('if (still || !water || ebbing) return;');
    expect(engine).toContain('const restTarget = ebbing ? 0 : 1;');
    expect(engine).toContain('if(P.y<0.)continue;');
    const css = read('src/styles/char-sea.css');
    expect(block(css, "html[data-char-sea='ebb'] .desktop-app-shell {", '}')).toMatch(
      /--workspace-ui-bg: transparent;[\s\S]*animation: char-sea-surface var\(--motion-structural\) ease-out both;/,
    );
    expect(css).toContain("html[data-char-sea='ebb'] .desktop-app-shell { animation: none; }");
    // A plate that cuts a line under it keeps the desk: the compact element
    // index's heading still cuts its category's sand frame.
    expect(block(css, "html[data-char-sea='ebb'] .desktop-app-shell {", '}')).toContain('--workspace-plate-bg: hsl(var(--paper-deep));');
    expect(block(read('src/styles/ui-controls.css'), '.left-sb-group-header--frame .left-sb-group-header__legend {', '}'))
      .toContain('background: var(--workspace-plate-bg, var(--workspace-ui-bg));');
  });

  it('opens a book only once its page is ready, then bursts the word into the workspace', () => {
    const workspace = read('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    expect(workspace).toContain('useWorkspaceOpening(rootRef);');
    expect(workspace).toContain('<WorkspaceOpeningCover />');
    const opening = read('src/renderer/shells/desktop/useWorkspaceOpening.ts');
    expect(opening).toContain('export const WORKSPACE_OPENING_LIMIT_MS = 2000;');
    expect(opening).toContain("const release = charSeaRegistry.hold('loading');");
    expect(opening).toContain('stopListening = onEditorStageReady(ready);');
    // Shown, the wait stays until "Loading" is up; a book ready before it showed opens at once.
    expect(opening).toContain('export const WORKSPACE_OPENING_SHOWN_MS = 600;');
    expect(opening).toContain('if (performance.now() < shownAt || wait <= 0) finish();');
    expect(read('src/renderer/components/editor/EditorMainArea.tsx')).toContain('announceEditorStageReady();');
    const css = read('src/styles/char-sea.css');
    expect(block(css, '.desktop-app-shell[data-opening] {', '}')).toMatch(/opacity: 0;[\s\S]*pointer-events: none;/);
    expect(block(css, '.workspace-opening-cover {', '}')).toContain('pointer-events: auto;');
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    expect(engine).toContain('const WORD_BURST = 2.5;');
    expect(engine).toContain('if (word.held) water?.hold(null, WORD_BURST);');
  });

  it('is written down in the design system', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('全屏加载与字海');
    expect(docs).toContain('`CharSea`');
    expect(read('docs/renderer-performance/startup-placeholder.md')).toContain('字海');
  });
});
