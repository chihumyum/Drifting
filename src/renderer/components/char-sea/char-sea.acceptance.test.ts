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
    // Wherever WebGL2 is there: no shell gate keeps the sea off a phone.
    expect(hooks).toContain('  return charSeaSupported();\n');
    expect(hooks).not.toContain('isMobileShell');

    const shelf = read('src/renderer/views/ProjectPickerView.tsx');
    expect(shelf).toContain("useCharSeaHold('surface', onSea);");
    expect(shelf).toContain("const shelfClass = onSea ? 'pp pp--sea' : 'pp';");
    expect(shelf).toMatch(
      /const \{ attach: glassRef, drawn: seaDrawn, hoverProps: glassHover \} = useCharSeaShape<HTMLElement>\(\{\s*rest: 0\.85,\s*radius: 2,\s*arrive: arrives,\s*waiting: sample\.waiting,\s*\}\);/,
    );
    expect(shelf).toContain("className={`pp-card glass glass--rest${sample.waiting ? ' glass--waiting' : ''}${seaDrawn ? ' pp-card--sea' : ''}`}");
    expect(shelf).toContain('data-char-sea-press=""');
    expect(shelf).toContain('const { attach: newSlipRef } = useCharSeaShape<HTMLDivElement>({ rest: 0, radius: 2, hover: false });');
    const picker = read('src/styles/project-picker.css');
    expect(block(picker, '.pp--sea {', '}')).toContain('background: transparent;');
    expect(block(picker, '.pp-card--sea.glass::before {', '}')).toContain('display: none;');
  });

  it('lays the first-run choice in the window on the sea: the name rises, lets go, and leaves the card in the rain', () => {
    const routes = read('src/renderer/app/AppRoutes.tsx');
    expect(routes).toMatch(/<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>\s*<\/PreAlphaFirstRunGate>/);
    const onboarding = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const gate = block(onboarding, 'export function PreAlphaFirstRunGate', '\n}\n');
    const card = block(onboarding, 'function FirstRunCard', '\n}\n');
    // Not a dialog over the window but a card in it, whose resting glass the sea draws, set down with no line at first.
    expect(gate + card).not.toMatch(/ModalRoot|ModalCard|aria-modal/);
    expect(card).toMatch(/useCharSeaShape<HTMLElement>\(\{\s*rest: leaving \? 0 : 0\.85,\s*radius: 2,\s*hover: false,\s*arrive: true,\s*\}\)/);
    expect(card).toContain("glass glass--rest glass--still${onSea ? ' first-run-gate__card--sea' : ''}");
    // A first run on the sea raises the name first; the rain falls through the name and round the card.
    expect(gate).toContain("guideOpen && onSea && !reducedMotion() ? 'title' : 'card'");
    expect(gate).toContain("useCharSeaHold('title', stage === 'title' && onSea);");
    expect(gate).toContain("useCharSeaHold('rain', (stage === 'title' || stage === 'card') && onSea);");
    expect(gate).toContain("window.setTimeout(() => setStage('card'), FIRST_RUN_TITLE_MS);");
    expect(gate).toContain("className={`first-run-gate${onSea ? ' first-run-gate--sea' : ''}");
    // The interface language waits in the window's corner the whole way, as the account menu offers it.
    expect(gate).toContain("{stage !== 'title' && shownStep && <FirstRunLanguage leaving={stage === 'leaving'} />}");
    const language = block(onboarding, 'function FirstRunLanguage', '\n}\n');
    expect(language).toContain('onChange={setUiLocale}');
    expect(language).toContain('options={UI_LOCALE_OPTIONS.map((locale) => ({ value: locale.code, label: locale.native }))}');
    expect(read('src/renderer/lib/char-sea/char-sea-registry.ts')).toContain("export const CHAR_SEA_TITLE = 'Drifting';");
    const css = read('src/styles/auth.css');
    expect(block(css, '.first-run-gate {', '}')).toContain('background: var(--workspace-ui-bg);');
    expect(block(css, '.first-run-gate--sea {', '}')).toContain('background: transparent;');
    expect(block(css, '.first-run-gate__card--sea.glass::before {', '}')).toContain('display: none;');
    expect(block(css, '.first-run-gate__language {', '}')).toMatch(/position: fixed;\s*right: 20px;\s*bottom: 16px;/);
    // A card that steps through a flow takes its drawn rim with it.
    expect(read('src/renderer/components/char-sea/useCharSea.ts')).toContain(
      'new ResizeObserver(() => charSeaRegistry.resized())',
    );

    // Rain holds the sea live and falls at once; the word belongs to a wait, which hands its rain over.
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    expect(component).toContain('const held = holds.loading > 0 || holds.title > 0 || holds.rain > 0 || holds.surfaces > 0;');
    // The name rises at once, and a word already standing gives way to it.
    expect(component).toContain('sea.current?.loading(true, CHAR_SEA_TITLE);');
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
    // A frame between two steps (above 100Hz) neither moves the water nor settles it.
    expect(engine).toContain('else if (steps) quietFrames = peak < 0.004 ? quietFrames + 1 : 0;');
    expect(engine).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')");
    // The rim is the app's resting glass: 1px of glass-clear at 33% × 1.8, cut by the same texture and tile.
    expect(engine).toContain("import glassTextureUrl from '../../../assets/design/glass-thick.png';");
    expect(engine).toContain('const GLASS_EDGE = 0.594;');
    expect(engine).toContain('const GLASS_TILE = 150;');
    // The line itself never moves: only its thickness and depth follow the water.
    expect(engine).toContain('float sd=sdBox(px,R,P.x);');
  });

  it('brings the shelf up from the first run as a whole and lands the sample on its own ring, flowing until it is opened', () => {
    const onboarding = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const gate = block(onboarding, 'export function PreAlphaFirstRunGate', '\n}\n');
    // The card fades as the shelf comes up under it; what mounts then is set down on the sea.
    expect(gate).toContain("window.setTimeout(() => setStage('done'), FIRST_RUN_LEAVE_MS);");
    expect(gate).toContain('<div key="shelf" className="first-run-arrival">');
    expect(gate).toContain("<FirstRunArrival.Provider value={stage === 'leaving'}>{children}</FirstRunArrival.Provider>");
    const css = read('src/styles/auth.css');
    expect(block(css, '.first-run-arrival {', '}')).toContain('animation: first-run-arrive var(--motion-structural) var(--motion-structural-ease) both;');
    expect(block(css, '.first-run-gate__card--leaving {', '}')).toContain('var(--motion-glass-bleed)');
    // The sample a first launch wrote: its own ring, then its rim flows as glass waiting on the author.
    const shelf = read('src/renderer/views/ProjectPickerView.tsx');
    expect(shelf).toContain('const [arrives] = useState(arriving || lands);');
    expect(shelf).toContain('charSeaRegistry.drop(rect.left + rect.width / 2, rect.top + rect.height / 2, SAMPLE_LANDING_DROP);');
    expect(shelf).toContain('}, SAMPLE_LANDING_DELAY_MS);');
    expect(shelf).toContain('noteBookOpened(id);');
    const component = read('src/renderer/components/char-sea/CharSea.tsx');
    expect(component).toContain('hover: entry.hover || entry.waiting,');
    expect(component).toContain('arrive: entry.options.arrive,');
    expect(component).toContain('charSeaRegistry.onDrop((x, y, amplitude) => sea.current?.drop(x, y, amplitude));');
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    expect(engine).toContain("else if (!restShown.has(shape.id)) restShown.set(shape.id, shape.arrive ? 0 : shape.rest);");
    // Opened, it waits no longer; the workspace tour takes over on the first book opened.
    expect(read('src/renderer/components/first-run/first-run-shelf.ts')).toContain(
      'useFirstRunShelfStore.setState({ sampleOpened: true });',
    );
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
    expect(engine).toContain('const WORD_BURST = 4;');
    expect(engine).toContain('if (word.held) water?.hold(null, WORD_BURST);');
  });

  it('gives the landing page its own word, place, sheet and ink, while the app keeps the sea it had', () => {
    const engine = read('src/renderer/lib/char-sea/char-sea.ts');
    // Without options: "Loading" in the middle, at most 70% wide, on the app's cells, its characters as on any crest.
    expect(engine).toContain('word = options.word ?? LOADING_WORD,');
    expect(engine).toContain('const span = options.wordSpan?.(width) ?? 0.7;');
    expect(engine).toContain('centreY: height * (options.wordCentreY ?? 0.5)');
    expect(engine).toContain('const density = options.density?.(width) ?? 1;');
    expect(engine).toContain('gl.uniform1f(U.wordInk, options.wordInk ?? 0);');
    expect(engine).toContain('float wk=uWordInk>0.?');
    expect(read('src/renderer/components/char-sea/CharSea.tsx')).toContain('const handle = createCharSea(canvas.current);');
    // The site raises its name from the same code, and asks nothing of another host.
    const entry = read('scripts/design-assets/landing/entry.mjs');
    expect(entry).toContain("from '../../../src/renderer/lib/char-sea/char-sea';");
    expect(entry).toContain("word: 'DRIFTING',");
    const page = read('scripts/design-assets/landing/index.html');
    expect(page).toContain('var box = S.wordBox(');
    // The rain falls the whole way down every page of the site, changing the characters it passes.
    expect(page).toContain('sea.rain(true);');
    const pages = read('scripts/design-assets/landing/pages.mjs');
    expect(pages).toContain("from '../../../src/renderer/lib/char-sea/char-sea';");
    expect(pages).toContain('sea.rain(true);');
    // Nothing from another host, on any page or in the sheet they share (canonical and alternate links only name pages).
    for (const file of ['index.html', 'site.css']) {
      expect(read(`scripts/design-assets/landing/${file}`)).not.toMatch(/<link(?![^>]*rel="(?:canonical|alternate)")[^>]+href="https?:|<script[^>]+src="https?:|url\(["']?https?:|@import|fonts\.googleapis/);
    }
    // The builder supplies each language's metadata and menu. The Showcase
    // routing tests check them on the generated pages.
    const build = read('scripts/design-assets/landing/build.mjs');
    for (const placeholder of ['metadata', 'software-schema', 'language-menu']) {
      expect(page).toContain(`{{${placeholder}}}`);
    }
    // The word and the sheets define the outline. Only FAQ questions add a third level.
    expect([...page.matchAll(/<h([12])\b/g)].map((m) => m[1]).join('')).toBe('1222222');
    expect(page.replace(/<section\b[^>]*id="faq"[\s\S]*?<\/section>/, '')).not.toMatch(/<h[3-6]\b/);
    expect(page).toContain("var el = document.createElement(kind === 'p' ? 'p' : 'div');");
    expect(build).toContain("path.join(root, 'node_modules/@fontsource-variable', face)");
    // A tab switch in the workspace corners pushes the panels and slides the glass block as the app does.
    const motion = read('src/renderer/lib/motion.ts');
    const pushMs = /export const PUSH_MS = (\d+);/.exec(motion)?.[1];
    const pushEasing = /export const PUSH_EASING = '([^']+)';/.exec(motion)?.[1];
    expect(page).toContain(`var PUSH_MS = ${pushMs}, PUSH_EASE = '${pushEasing}';`);
    expect(page).toContain('<i class="sb-tab-block glass is-on" aria-hidden="true"></i>');
    // The name in the bar is written in sand with the sharing card's brush, and the link keeps the word.
    expect(read('scripts/design-assets/landing/site.css')).toContain('mask: url({{asset:sand/wordmark-drifting.png}})');
    expect(read('scripts/design-assets/landing/wordmark.html')).toContain("import { letterMark } from '../social-preview/sand-letters.js';");
    expect(page).toMatch(/<a class="brand glass glass--rest"[^>]*>DRIFTING<\/a>/);
    // The site's buttons rest as a faint line, flow under the pointer and thicken when pressed, as the app's floating controls do.
    const site = read('scripts/design-assets/landing/site.css');
    expect(site).toContain('.pill.glass--primary { --glass-g: 0.85; --glass-sp: 0; }');
    expect(site).toContain(':is(.pill, .round, .brand).glass:active { --glass-g: 1.7; --glass-sp: 1.3; }');
    // The theme follows the system on every visit: a pick is kept for the tab only.
    const prefs = read('scripts/design-assets/landing/prefs.js');
    expect(prefs).toContain('sessionStorage.getItem(THEME_KEY)');
    expect(prefs).not.toContain('localStorage.getItem(THEME_KEY)');
  });

  it('is written down in the design system', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('全屏加载与字海');
    expect(docs).toContain('`CharSea`');
    expect(docs).toContain('`CharSeaOptions`');
    expect(read('docs/renderer-performance/startup-placeholder.md')).toContain('字海');
  });
});
