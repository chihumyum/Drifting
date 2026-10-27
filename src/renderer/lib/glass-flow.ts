/**
 * Lines that bleed glass while their panel moves (`.flow-line` in
 * materials.css). The owner element carries two custom properties:
 * `--flow`, the distance it has travelled, which moves the glass texture so it
 * runs, slows and stops with the panel; and `--flowa`, how strong the glass
 * is, following the panel's speed. `.is-moving` holds the glass while it
 * moves; once it rests the glass fades out whole.
 */

interface FlowState {
  raf: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  lastStep: number;
  strength: number;
}

const states = new WeakMap<HTMLElement, FlowState>();

function stateOf(el: HTMLElement): FlowState {
  let state = states.get(el);
  if (!state) {
    state = { raf: 0, idle: undefined, lastStep: 0, strength: 0 };
    states.set(el, state);
  }
  return state;
}

function travelledOf(el: HTMLElement) {
  return Number(el.style.getPropertyValue('--flow')) || 0;
}

function rest(el: HTMLElement, state: FlowState) {
  cancelAnimationFrame(state.raf);
  clearTimeout(state.idle);
  state.raf = 0;
  state.idle = undefined;
  state.lastStep = 0;
  state.strength = 0;
  el.classList.remove('is-moving');
  el.style.setProperty('--flowa', '0');
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Follow a panel that animates on its own (a CSS transition): read its size
 * every frame until it has been still for a few frames or a second passes.
 */
export function trackGlassFlow(el: HTMLElement, size: () => number) {
  if (reducedMotion()) return;
  const state = stateOf(el);
  cancelAnimationFrame(state.raf);
  clearTimeout(state.idle);
  el.classList.add('is-moving');
  let last = size();
  let travelled = travelledOf(el);
  let lastTime = performance.now();
  const start = lastTime;
  let still = 0;
  const tick = (now: number) => {
    const value = size();
    const distance = Math.abs(value - last);
    const elapsed = Math.max(1, now - lastTime);
    last = value;
    lastTime = now;
    travelled += distance;
    const target = Math.min(1, 0.5 + (distance / elapsed) * 0.8);
    state.strength += (target - state.strength) * 0.45;
    el.style.setProperty('--flow', travelled.toFixed(1));
    el.style.setProperty('--flowa', state.strength.toFixed(3));
    still = distance < 0.05 ? still + 1 : 0;
    if ((now - start < 140 || still < 3) && now - start < 1000) {
      state.raf = requestAnimationFrame(tick);
    } else {
      rest(el, state);
    }
  };
  state.raf = requestAnimationFrame(tick);
}

/**
 * Move a panel by hand (a drag-resize): each step adds the distance moved;
 * when the hand rests for a moment the glass fades.
 */
export function stepGlassFlow(el: HTMLElement, distance: number) {
  if (!distance || reducedMotion()) return;
  const state = stateOf(el);
  const now = performance.now();
  const elapsed = Math.max(1, now - (state.lastStep || now));
  state.lastStep = now;
  el.classList.add('is-moving');
  const target = Math.min(1, 0.45 + (distance / elapsed) * 0.8);
  state.strength += (target - state.strength) * 0.5;
  el.style.setProperty('--flow', (travelledOf(el) + distance).toFixed(1));
  el.style.setProperty('--flowa', state.strength.toFixed(3));
  clearTimeout(state.idle);
  state.idle = setTimeout(() => rest(el, state), 140);
}

export function restGlassFlow(el: HTMLElement) {
  rest(el, stateOf(el));
}
