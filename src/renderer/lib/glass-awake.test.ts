import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLASS_AWAKE_ATTRIBUTE, installGlassAwake } from './glass-awake';

interface FakeElement {
  parentElement: FakeElement | null;
  children: FakeElement[];
  isConnected: boolean;
  hovered: boolean;
  rimOpacity: string;
  drift: number;
  classList: { contains(name: string): boolean };
  matches(selector: string): boolean;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): FakeElement | null;
  getAnimations(): Array<{ animationName: string; currentTime: number }>;
}

/** Just enough of an element for the waker: rim owners, hover and its drift. */
function element(kind: 'glass' | 'cell' | 'ring' | 'plain', parent: FakeElement | null = null): FakeElement {
  const attributes = new Set<string>();
  const self: FakeElement = {
    parentElement: parent,
    children: [],
    isConnected: true,
    hovered: false,
    rimOpacity: '0',
    drift: 0,
    classList: { contains: (name) => (name === 'glass' && kind === 'glass') || (name === 'cell-ring' && kind === 'ring') },
    matches: (selector) => {
      if (selector === '.glass, :has(> .cell-ring)') return kind === 'glass' || self.children.some((child) => child.classList.contains('cell-ring'));
      if (selector === ':hover, :focus-within') return self.hovered;
      if (selector === '.cell-ring') return kind === 'ring';
      return false;
    },
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => { attributes.add(name); },
    removeAttribute: (name) => { attributes.delete(name); },
    querySelector: () => self.children.find((child) => child.classList.contains('cell-ring')) ?? null,
    // CSS gives the rim its animation only while its owner is awake.
    getAnimations: () => attributes.has(GLASS_AWAKE_ATTRIBUTE)
      ? [{ animationName: 'glass-flow', currentTime: self.drift }]
      : [],
  };
  parent?.children.push(self);
  return self;
}

function harness() {
  const listeners = new Map<string, (event: Event) => void>();
  const timers = new Map<number, () => void>();
  let next = 1;
  const root = {
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const environment = {
    getComputedStyle: (target: Element) => ({ opacity: (target as unknown as FakeElement).rimOpacity }),
    setTimeout: (callback: () => void) => { const id = next++; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  const uninstall = installGlassAwake(root, environment);
  const fire = (type: string, target: FakeElement, extra: Record<string, unknown> = {}) =>
    listeners.get(type)?.({ target, ...extra } as unknown as Event);
  const settle = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  return { fire, settle, timers, listeners, uninstall };
}

describe('waking glass rims only while they can drift', () => {
  it('wakes every rim owner under the pointer and lets an untouched rim sleep', () => {
    const { fire, settle } = harness();
    const cell = element('cell');
    element('ring', cell);
    const button = element('glass', cell);
    const label = element('plain', button);

    fire('pointerover', label);
    expect(button.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);
    expect(cell.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);

    fire('pointerout', label);
    expect(button.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);
    settle();
    expect(button.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(false);
    expect(cell.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(false);
  });

  it('keeps a drifted rim that still shows, and lets it sleep once it fades', () => {
    const { fire, settle } = harness();
    const pill = element('glass');
    fire('pointerover', pill);
    pill.drift = 3000;
    pill.rimOpacity = '1';
    fire('pointerout', pill);
    settle();
    expect(pill.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);

    pill.rimOpacity = '0';
    fire('transitionend', pill, { propertyName: 'box-shadow' });
    expect(pill.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);
    fire('transitionend', pill, { propertyName: 'opacity' });
    expect(pill.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(false);
  });

  it('lets a ring sleep when its own fade ends', () => {
    const { fire, settle } = harness();
    const cell = element('cell');
    const ring = element('ring', cell);
    fire('focusin', cell);
    cell.drift = 1200;
    ring.rimOpacity = '1';
    fire('focusout', cell);
    settle();
    expect(cell.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);
    ring.rimOpacity = '0';
    fire('transitionend', ring, { propertyName: 'opacity' });
    expect(cell.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(false);
  });

  it('stays awake while still pointed at, and a return cancels the pending sleep', () => {
    const { fire, settle, timers } = harness();
    const button = element('glass');
    fire('pointerover', button);
    fire('pointerout', button);
    expect(timers.size).toBe(1);
    fire('pointerover', button);
    expect(timers.size).toBe(0);

    fire('pointerout', button);
    button.hovered = true;
    settle();
    expect(button.hasAttribute(GLASS_AWAKE_ATTRIBUTE)).toBe(true);
  });

  it('removes its listeners and timers', () => {
    const { fire, uninstall, listeners, timers } = harness();
    const button = element('glass');
    fire('pointerover', button);
    fire('pointerout', button);
    uninstall();
    expect(listeners.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  it('gives resting rims no animation and installs the waker at boot', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/materials.css'), 'utf8');
    expect(css).toContain('.glass:not([data-glass-awake], .glass--waiting, .glass-sweep)::before { animation-name: none; }');
    expect(css).toContain(':not([data-glass-awake]) > .cell-ring { animation-name: none; }');
    // Without its animation a ring must rest where the animation starts.
    const ring = css.slice(css.indexOf('.sand-cell > .cell-ring {'), css.indexOf(':not([data-glass-awake]) > .cell-ring'));
    expect(ring).toContain('mask-position: var(--glass-gx) var(--glass-gy);');
    const main = readFileSync(resolve(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    expect(main).toContain('installGlassAwake(document);');
  });
});
