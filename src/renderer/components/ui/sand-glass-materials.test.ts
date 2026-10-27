import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KindMark } from './KindMark';
import { kindMarkOfTarget } from './kind-mark';
import { SandCell } from './SandCell';
import { restGlassFlow, stepGlassFlow } from '../../lib/glass-flow';

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

  it('lights a busy mark in the accent and keeps loose drifts fainter', () => {
    const busy = renderToStaticMarkup(createElement(KindMark, { kind: 'element', color: '#5f9483', busy: true }));
    expect(busy).toContain('agent-glyph-busy');
    expect(busy).toContain('--sand-c:hsl(var(--accent))');
    const loose = renderToStaticMarkup(createElement(KindMark, { kind: 'drift', loose: true }));
    expect(loose).toContain('kind-mark--loose');
    expect(loose).toContain('sand--spiral');
  });
});

describe('sand cells', () => {
  it('fades in a selection that exists when the cell mounts instead of drawing it', () => {
    const settled = renderToStaticMarkup(createElement(SandCell, { selected: true, color: '#a85443', markCenter: 19 }, 'x'));
    expect(settled).toContain('sand-cell is-selected is-settled');
    expect(settled).toContain('--cell-frame-origin:21px');
    expect(settled).toContain('<i class="cell-ring" aria-hidden="true"></i>');
    expect(settled).toContain('<i class="cell-frame" aria-hidden="true"></i>');
    const resting = renderToStaticMarkup(createElement(SandCell, { selected: false }, 'x'));
    expect(resting).not.toContain('is-selected');
    expect(resting).not.toContain('is-settled');
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

  it('stays still for readers who reduce motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { el, values } = element();
    stepGlassFlow(el, 30);
    expect(values.has('--flow')).toBe(false);
  });
});
