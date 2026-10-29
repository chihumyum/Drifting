import { WAVE_BASE_MS, WAVE_MAX_ITEMS, WAVE_PER_ITEM_MS, WAVE_SETTLE_MS } from './motion';

/**
 * A selection that flows between siblings of one glass family (the dock's
 * pills). When the selected item changes, its still bleed travels from the
 * old item to the new one as a single band of water: the items it passes
 * light up in their own colour and fade again, the band spreads and thins a
 * little on the way, and one sheet of texture slides under it so the glass
 * keeps its uneven waver. Once it lands it stands still.
 *
 * Each item carries a `.glass-wave` layer (materials.css) drawn like its
 * selected rim and keyed by `data-wave-key`. The band cuts every layer with a
 * soft window in that layer's own pixels (`--wave-a0 … --wave-b1`, strength
 * `--wave-k`, texture offset `--wave-tx`). The container holds
 * `data-glass-waving="move"` while the band travels, which keeps the newly
 * selected item on its resting line, then `"settle"` while the band fades and
 * the item's own bleed comes in. An item chosen by pressing it skips the
 * resting line (`data-wave-landed`): it eases straight from its held-down
 * depth to the selected one while the band still flows in to meet it.
 */

export interface WaveSpan {
  left: number;
  right: number;
}

export interface WaveFrame extends WaveSpan {
  /** 0–1: how strong the band is. */
  strength: number;
  /** Soft edge on each side, px. */
  feather: number;
}

export interface WaveWindow {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

const outCubic = (t: number) => 1 - (1 - t) ** 3;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** How long the band takes to cross `distance` px between items `pitch` px apart. */
export function waveDuration(distance: number, pitch: number) {
  return WAVE_BASE_MS + WAVE_PER_ITEM_MS * Math.min(WAVE_MAX_ITEMS, Math.abs(distance) / Math.max(1, pitch));
}

/**
 * Where the band is `t` (0–1) of the way from one item's span to another's:
 * fast away, gentle on arrival, a little wider and fainter mid-way.
 */
export function waveFrame(from: WaveSpan, to: WaveSpan, t: number): WaveFrame {
  const clamped = Math.min(1, Math.max(0, t));
  const eased = outCubic(clamped);
  const bell = Math.sin(Math.PI * clamped);
  const centre = mix((from.left + from.right) / 2, (to.left + to.right) / 2, eased);
  const width = mix(from.right - from.left, to.right - to.left, eased) * (1 + 0.35 * bell);
  return {
    left: centre - width / 2,
    right: centre + width / 2,
    strength: 1 - 0.18 * bell,
    feather: 2 + 14 * bell,
  };
}

/** The band's window in one item's own coordinates, or null when it misses the item. */
export function waveWindow(frame: WaveFrame, item: { x: number; width: number }): WaveWindow | null {
  const a1 = frame.left - item.x;
  const b0 = frame.right - item.x;
  const a0 = a1 - frame.feather;
  const b1 = b0 + frame.feather;
  if (b1 <= 0 || a0 >= item.width) return null;
  return { a0, a1, b0, b1 };
}

interface WaveItem {
  el: HTMLElement;
  x: number;
  width: number;
}

interface WaveState {
  raf: number;
  settle: ReturnType<typeof setTimeout> | undefined;
  /** The band's span while it travels, in container px. */
  span: WaveSpan | null;
  texture: number;
}

const states = new WeakMap<HTMLElement, WaveState>();

function stateOf(container: HTMLElement): WaveState {
  let state = states.get(container);
  if (!state) {
    state = { raf: 0, settle: undefined, span: null, texture: -14 };
    states.set(container, state);
  }
  return state;
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function itemsOf(container: HTMLElement) {
  const origin = container.getBoundingClientRect().left;
  const items = new Map<string, WaveItem>();
  container.querySelectorAll<HTMLElement>('.glass-wave[data-wave-key]').forEach((el) => {
    const rect = el.getBoundingClientRect();
    items.set(el.dataset.waveKey!, { el, x: rect.left - origin, width: rect.width });
  });
  return items;
}

function paint(items: Iterable<WaveItem>, frame: WaveFrame, texture: number) {
  for (const item of items) {
    const style = item.el.style;
    const cut = waveWindow(frame, item);
    if (!cut) {
      style.setProperty('--wave-k', '0');
      continue;
    }
    style.setProperty('--wave-k', frame.strength.toFixed(3));
    style.setProperty('--wave-a0', `${cut.a0.toFixed(1)}px`);
    style.setProperty('--wave-a1', `${cut.a1.toFixed(1)}px`);
    style.setProperty('--wave-b0', `${cut.b0.toFixed(1)}px`);
    style.setProperty('--wave-b1', `${cut.b1.toFixed(1)}px`);
    style.setProperty('--wave-tx', `${(texture - item.x).toFixed(1)}px`);
  }
}

/** Stops any band at once and drops the container back to its plain state. */
export function restGlassWave(container: HTMLElement) {
  const state = stateOf(container);
  cancelAnimationFrame(state.raf);
  clearTimeout(state.settle);
  state.raf = 0;
  state.settle = undefined;
  state.span = null;
  container.removeAttribute('data-glass-waving');
  clearLanded(container);
}

function clearLanded(container: HTMLElement) {
  container.querySelectorAll('[data-wave-landed]').forEach((el) => el.removeAttribute?.('data-wave-landed'));
}

/**
 * Sends the selection's bleed from item `from` to item `to`. A band already
 * travelling carries on from where it is. `pressed`: `to` was chosen by
 * pressing it, so it keeps its own bleed instead of waiting for the band.
 */
export function flowGlassSelection(container: HTMLElement, from: string, to: string, pressed = false) {
  if (reducedMotion()) return;
  const state = stateOf(container);
  const items = itemsOf(container);
  const target = items.get(to);
  const origin = items.get(from);
  const source = state.span ?? (origin ? { left: origin.x, right: origin.x + origin.width } : null);
  if (!target || !source) {
    restGlassWave(container);
    return;
  }
  cancelAnimationFrame(state.raf);
  clearTimeout(state.settle);
  const end: WaveSpan = { left: target.x, right: target.x + target.width };
  const all = [...items.values()];
  const pitch = all.reduce((sum, item) => sum + item.width, 0) / all.length;
  const duration = waveDuration((end.left + end.right - source.left - source.right) / 2, pitch);
  const start = performance.now();
  let lead = (source.left + source.right) / 2;
  clearLanded(container);
  if (pressed) target.el.parentElement?.setAttribute('data-wave-landed', '');
  container.setAttribute('data-glass-waving', 'move');
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const frame = waveFrame(source, end, t);
    const centre = (frame.left + frame.right) / 2;
    state.texture += (centre - lead) * 0.45;
    lead = centre;
    state.span = { left: frame.left, right: frame.right };
    paint(all, frame, state.texture);
    if (t < 1) {
      state.raf = requestAnimationFrame(tick);
      return;
    }
    state.raf = 0;
    state.span = null;
    container.setAttribute('data-glass-waving', 'settle');
    state.settle = setTimeout(() => {
      state.settle = undefined;
      container.removeAttribute('data-glass-waving');
      clearLanded(container);
    }, WAVE_SETTLE_MS);
  };
  state.raf = requestAnimationFrame(tick);
}
