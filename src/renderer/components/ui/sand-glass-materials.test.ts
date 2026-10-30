import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KindMark } from './KindMark';
import { kindMarkOfTarget } from './kind-mark';
import { SandCell } from './SandCell';
import { restGlassFlow, stepGlassFlow, stepInnerGlassFlow } from '../../lib/glass-flow';

describe('kind marks', () => {
  it('gives every tab-able kind its own mark', () => {
    expect(kindMarkOfTarget('node')).toBe('chapter');
    expect(kindMarkOfTarget('node', true)).toBe('drift');
    expect(kindMarkOfTarget('element')).toBe('element');
    expect(kindMarkOfTarget('storyline')).toBe('storyline');
    expect(kindMarkOfTarget('category')).toBe('category');
    expect(kindMarkOfTarget('library_item')).toBe('material');
    expect(kindMarkOfTarget('all-chapters')).toBe('all');
  });

  it('presses the same seal for the same chapter in every list and the dock', () => {
    const seal = (seed: string) => renderToStaticMarkup(createElement(KindMark, { kind: 'chapter', seed, color: '#a85443' }));
    expect(seal('n1')).toBe(seal('n1'));
    expect(seal('n1')).toMatch(/sand--blob-[0-5]/);
    expect(seal('n1')).toContain('--sand-c:#a85443');
  });

  it('lights a busy mark in the accent, hollows a preview and keeps loose drifts fainter', () => {
    const busy = renderToStaticMarkup(createElement(KindMark, { kind: 'element', color: '#5f9483', busy: true }));
    expect(busy).toContain('agent-glyph-busy');
    expect(busy).toContain('--sand-c:hsl(var(--accent))');
    const hollow = renderToStaticMarkup(createElement(KindMark, { kind: 'chapter', seed: 'n1', hollow: true }));
    expect(hollow).toContain('kind-mark--hollow');
    const loose = renderToStaticMarkup(createElement(KindMark, { kind: 'drift', loose: true }));
    expect(loose).toContain('kind-mark--loose');
    expect(loose).toContain('sand--spiral');
  });
});

describe('hollow marks', () => {
  it('has a generated hollow mask for every shape a tab can show', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/materials.css'), 'utf8');
    for (const [shape, file] of [
      ...[0, 1, 2, 3, 4, 5].map((index) => [`blob-${index}`, `blob-${index}`]),
      ['square', 'mark-square'], ['star', 'mark-star'], ['dash', 'mark-dash'],
      ['slip', 'mark-slip'], ['spiral', 'mark-spiral'], ['corner', 'mark-corner'],
    ]) {
      expect(css).toContain(`.kind-mark--hollow > .sand--${shape} { --sand-mask: url('../assets/design/sand/${file}-hollow.png'); }`);
      expect(existsSync(resolve(process.cwd(), `src/assets/design/sand/${file}-hollow.png`)), file).toBe(true);
    }
  });
});

describe('sand cells', () => {
  it('carries a frame drawn for the cell only while it is selected', () => {
    const selected = renderToStaticMarkup(createElement(SandCell, { selected: true, color: '#a85443' }, 'x'));
    expect(selected).toContain('sand-cell is-selected');
    expect(selected).toContain('--cell-c:#a85443');
    expect(selected).toContain('<i class="cell-ring" aria-hidden="true"></i>');
    expect(selected).toContain('<canvas class="cell-frame" aria-hidden="true"></canvas>');
    const resting = renderToStaticMarkup(createElement(SandCell, { selected: false }, 'x'));
    expect(resting).not.toContain('is-selected');
    expect(resting).not.toContain('cell-frame');
  });

  it('draws the frame at run time instead of stretching a fixed image', () => {
    const materials = readFileSync(resolve(process.cwd(), 'src/styles/materials.css'), 'utf8');
    expect(materials).not.toContain('sand/frame.png');
    expect(materials).not.toContain('--cell-sweep');
    for (const file of ['frame', 'frame-tile']) {
      expect(existsSync(resolve(process.cwd(), `src/assets/design/sand/${file}.png`)), file).toBe(false);
    }
    const frame = materials.slice(materials.indexOf('.sand-cell > .cell-frame {'), materials.indexOf('.sand-cell.is-selected > .cell-frame {'));
    expect(frame).toContain('width: calc(100% + 14px);');
    expect(frame).toContain('color: color-mix(in srgb, var(--cell-c, hsl(var(--ink-3))), #ffffff var(--pigment-lift));');
  });
});

describe('lines that bleed glass while their panel moves', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const element = () => {
    const values = new Map<string, string>();
    const classes = new Set<string>();
    return {
      el: {
        style: {
          getPropertyValue: (name: string) => values.get(name) ?? '',
          setProperty: (name: string, value: string) => values.set(name, value),
        },
        classList: {
          add: (value: string) => classes.add(value),
          remove: (value: string) => classes.delete(value),
        },
      } as unknown as HTMLElement,
      values,
      classes,
    };
  };

  it('moves the glass by the distance travelled and fades it once the hand rests', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { el, values, classes } = element();
    stepGlassFlow(el, 12);
    stepGlassFlow(el, 8);
    expect(values.get('--flow')).toBe('20.0');
    expect(Number(values.get('--flowa'))).toBeGreaterThan(0);
    expect(classes.has('is-moving')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(values.get('--flowa')).toBe('0');
    expect(classes.has('is-moving')).toBe(false);
    restGlassFlow(el);
  });

  it('moves an inner owner on its own pair, so it bleeds its lines without hiding the outer one', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { el, values, classes } = element();
    stepInnerGlassFlow(el, 6);
    stepInnerGlassFlow(el, 9);
    expect(values.get('--flow-inner')).toBe('15.0');
    expect(Number(values.get('--flowa-inner'))).toBeGreaterThan(0);
    // The outer pair is never written here: the shell's own moves reach the lines.
    expect(values.has('--flow')).toBe(false);
    expect(values.has('--flowa')).toBe(false);
    expect(classes.has('is-moving')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(values.get('--flowa-inner')).toBe('0');
    expect(values.has('--flowa')).toBe(false);
    expect(classes.has('is-moving')).toBe(false);

    // A line shows the stronger pair and runs by both distances.
    const materials = readFileSync(resolve(process.cwd(), 'src/styles/materials.css'), 'utf8');
    const lines = materials.slice(materials.indexOf('.flow-line {'), materials.indexOf('/* ── Sand'));
    expect(lines).toContain('opacity: calc(max(var(--flowa, 0), var(--flowa-inner, 0)) * 0.8);');
    expect(lines).toContain('mask-position: calc((var(--flow, 0) + var(--flow-inner, 0)) * 1.2px + var(--flow-gx, 0px)) var(--flow-gy, 0px);');
    expect(lines).toContain('mask-position: var(--flow-gx, 0px) calc((var(--flow, 0) + var(--flow-inner, 0)) * 1.6px + var(--flow-gy, 0px));');
  });

  it('stays still for readers who reduce motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { el, values } = element();
    stepGlassFlow(el, 30);
    expect(values.has('--flow')).toBe(false);
  });
});

describe('resting glass and switches', () => {
  const css = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

  it('rests on the thin line alone and brings the bleed in under the pointer', () => {
    const materials = css('src/styles/materials.css');
    expect(materials).toContain('.glass--rest { --glass-g: 0.85; --glass-sp: 0; }');
    expect(materials).toContain('.glass--rest:focus-visible { --glass-g: 1; --glass-sp: 1; }');
    // Selected keeps the pointer's rim and bleed, still; only a held press
    // thickens, declared after both so it wins over them.
    const selected = materials.indexOf('.glass.is-on { --glass-g: 1; --glass-sp: 1; }');
    const held = materials.indexOf('.glass:active { --glass-g: 1.7; --glass-sp: 1.3; }');
    expect(selected).toBeGreaterThan(materials.indexOf('.glass--rest:focus-visible { --glass-g: 1; --glass-sp: 1; }'));
    expect(held).toBeGreaterThan(selected);
    const selectedBefore = materials.slice(materials.indexOf('.glass.is-on::before {'), held);
    expect(selectedBefore).toContain('animation-play-state: paused;');
    expect(selectedBefore).toContain('box-shadow var(--motion-glass-settle) ease-out');
  });

  it('gives small glass the dense patch through one rule instead of a copy per control', async () => {
    const materials = css('src/styles/materials.css');
    expect(materials).toContain('--glass-dense-gx: -96px;');
    expect(materials).toContain('--glass-dense-gy: -132px;');
    const small = '.glass.glass--small,\n.glass.glass--round { --glass-gx: var(--glass-dense-gx); --glass-gy: var(--glass-dense-gy); }';
    expect(materials).toContain(small);
    // After the rotation, so it wins over every sibling patch.
    expect(materials.indexOf(small)).toBeGreaterThan(materials.indexOf('.glass:nth-of-type(4n + 4)'));
    // No stylesheet keeps its own copy of the dense patch.
    const { readdirSync } = await import('node:fs');
    for (const file of readdirSync(resolve(process.cwd(), 'src/styles'))) {
      if (!file.endsWith('.css') || file === 'materials.css') continue;
      expect(css(`src/styles/${file}`), file).not.toContain('-132px');
    }
    // The shared controls are small glass wherever they render.
    expect(css('src/renderer/components/ui/Button.tsx')).toContain("default: 'glass glass--rest glass--small',");
    expect(css('src/renderer/components/ui/GhostIconButton.tsx')).toContain("glass === 'round' ? 'glass--round' : glass ? 'glass--small' : '',");
    expect(css('src/renderer/components/ui/GlassSelect.tsx')).toContain('`ui-select glass glass--rest glass--field glass--small ${className}`');
  });

  it('flows the selected bleed to a new sibling and keeps the new one on its line meanwhile', () => {
    const materials = css('src/styles/materials.css');
    expect(materials).toContain("[data-glass-waving='move'] .glass-wave { opacity: var(--wave-k, 0); }");
    // …unless it was chosen by pressing it: then it eases straight from held
    // down to selected while the band flows in to meet it.
    expect(materials).toContain("[data-glass-waving='move'] .glass.is-on:not([data-wave-landed]) { --glass-g: 0.85; --glass-sp: 0; }");
    expect(materials).toContain("[data-glass-waving='settle'] .glass-wave { opacity: 0; transition: opacity var(--motion-glass-settle) ease-out; }");
    // The band is drawn like the selected rim: strength 1, bleed 1, never flowing on its own.
    const wave = materials.slice(materials.indexOf('.glass-wave::before {'), materials.indexOf("[data-glass-waving='move']"));
    expect(wave).toContain('calc(var(--glass-edge) * 1.8)');
    expect(wave).toContain('inset 0 0 var(--glass-rim) 1px var(--wave-ring)');
    expect(wave).not.toContain('animation');
  });

  it('draws a switch as a glass track with a still accent bleed and a clean thumb', async () => {
    const { Switch } = await import('./Switch');
    const on = renderToStaticMarkup(createElement(Switch, { checked: true, onCheckedChange: () => {} }));
    expect(on).toContain('class="ui-switch ui-switch--md is-on"');
    expect(on).toContain('<span class="ui-switch__tint" aria-hidden="true"></span>');
    const controls = css('src/styles/ui-controls.css');
    expect(controls).toContain('.ui-switch.is-on .ui-switch__tint {\n  opacity: 1;\n}');
    expect(controls).toContain('background: var(--switch-thumb-bg);');
    // Only the clear rim flows; the accent tint never animates.
    expect(controls).toContain('animation: switch-rim-flow var(--motion-glass-drift) linear infinite paused;');
    expect(controls.slice(controls.indexOf('.ui-switch__tint {\n  --switch-tint'), controls.indexOf('.ui-switch.is-on .ui-switch__tint'))).not.toContain('animation');
    // The track is small glass: its line reads the dense patch and drifts from there.
    const track = controls.slice(controls.indexOf('.ui-switch::before {\n  --switch-rim'), controls.indexOf('.ui-switch:hover:not(:disabled)::before'));
    expect(track).toContain('mask-position: var(--glass-dense-gx) var(--glass-dense-gy);');
    expect(controls).toContain('mask-position: calc(var(--glass-dense-gx) + 150px) calc(var(--glass-dense-gy) + 150px);');
  });
});

describe('the dark theme', () => {
  const css = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

  it('casts every lifted surface\'s shadow in black, never in the near-white ink', async () => {
    const tokens = css('src/styles/index.css');
    const dark = tokens.slice(tokens.indexOf('  .dark {'));
    expect(tokens.slice(0, tokens.indexOf('  .dark {'))).toContain('--shadow-ink: 30 6% 12%;');
    expect(dark).toContain('--shadow-ink: 0 0% 0%;');
    expect(dark).toContain('0 16px 30px -16px hsl(var(--shadow-ink) / 0.62);');
    expect(css('src/styles/desktop-shell.css')).toContain('.dark .app-tab--drag-ghost {\n  filter: drop-shadow(0 8px 12px hsl(var(--shadow-ink) / 0.4));');
    // A shadow drawn in the ink glows on the dark. Hairlines (a zero-blur
    // half-pixel ring) and inset lines stay ink. The second batch's surfaces
    // (Super View, settings, the shelf) and the paused mobile shell move with
    // their own migrations.
    const pending = new Set(['graph-view.css', 'super-view-header.css', 'settings.css', 'project-picker.css']);
    const { readdirSync } = await import('node:fs');
    for (const file of readdirSync(resolve(process.cwd(), 'src/styles'))) {
      if (!file.endsWith('.css') || file.startsWith('mobile-') || pending.has(file)) continue;
      const text = css(`src/styles/${file}`).replace(/\/\*[\s\S]*?\*\//gu, '');
      for (const declaration of text.matchAll(/(?:box-shadow|filter|--[\w-]*shadow)\s*:([^;]+);/gu)) {
        for (const layer of declaration[1].split(',')) {
          if (!layer.includes('var(--ink-1)')) continue;
          expect(/^\s*(inset\b|0 0 0 0\.5px)/u.test(layer), `${file}: ${layer.trim()}`).toBe(true);
        }
      }
    }
  });

  it('lifts a coloured bleed toward white on the dark, leaving the line alone', () => {
    const materials = css('src/styles/materials.css');
    expect(materials).toContain('--glass-bleed-lift: 0%;');
    expect(materials.slice(materials.indexOf('.dark {'))).toContain('--glass-bleed-lift: 45%;');
    expect(materials).toContain('color-mix(in srgb, color-mix(in srgb, var(--glass-cc), white var(--glass-bleed-lift))');
    const glass = materials.slice(materials.indexOf('.glass::before {'), materials.indexOf('.glass:nth-of-type(4n + 1)'));
    expect(glass).toContain('inset 0 0 0 1px var(--glass-ring),');
    expect(glass).toContain('calc(1px * var(--glass-sp)) var(--glass-bleed);');
  });
});
