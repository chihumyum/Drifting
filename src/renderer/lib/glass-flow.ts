/**
 * Lines that bleed glass while their panel moves (`.flow-line` in
 * materials.css). The owner element carries two custom properties:
 * `--flow`, the distance it has travelled, which moves the glass texture so it
 * runs, slows and stops with the panel; and `--flowa`, how strong the glass
 * is, following the panel's speed. `.is-moving` holds the glass while it
 * moves; once it rests the glass fades out whole.
 *
 * An owner inside another (the seam between a sidebar's two columns, inside
 * the sidebar's shell) writes a second pair, `--flow-inner` and
 * `--flowa-inner`: a line shows the stronger of the two and runs by both
 * distances, so only the lines under the inner owner bleed while it moves,
 * and neither owner ever hides the other's from them. Glass that runs with
 * its own travel (a panel tab's block, a slider's thumb) reads `--flow` alone.
 */

interface FlowChannel {
  flow: string;
  strength: string;
}

const OUTER: FlowChannel = { flow: '--flow', strength: '--flowa' };
const INNER: FlowChannel = { flow: '--flow-inner', strength: '--flowa-inner' };

interface FlowState {
  raf: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  lastStep: number;
  strength: number;
  channel: FlowChannel;
}

const states = new WeakMap<HTMLElement, FlowState>();

function stateOf(el: HTMLElement): FlowState {
  let state = states.get(el);
  if (!state) {
    state = { raf: 0, idle: undefined, lastStep: 0, strength: 0, channel: OUTER };
    states.set(el, state);
  }
  return state;
}

function travelledOf(el: HTMLElement, channel: FlowChannel) {
  return Number(el.style.getPropertyValue(channel.flow)) || 0;
}

function rest(el: HTMLElement, state: FlowState) {
  cancelAnimationFrame(state.raf);
  clearTimeout(state.idle);
  state.raf = 0;
  state.idle = undefined;
  state.lastStep = 0;
  state.strength = 0;
  el.classList.remove('is-moving');
  el.style.setProperty(state.channel.strength, '0');
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
  state.channel = OUTER;
  el.classList.add('is-moving');
  let last = size();
  let travelled = travelledOf(el, state.channel);
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
    el.style.setProperty(state.channel.flow, travelled.toFixed(1));
    el.style.setProperty(state.channel.strength, state.strength.toFixed(3));
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
  step(el, distance, OUTER);
}

/**
 * Move part of a panel by hand from inside it (the seam between a sidebar's
 * two columns): only the lines under `el` bleed, on the inner pair, and the
 * panel's own movement still reaches them.
 */
export function stepInnerGlassFlow(el: HTMLElement, distance: number) {
  step(el, distance, INNER);
}

function step(el: HTMLElement, distance: number, channel: FlowChannel) {
  if (!distance || reducedMotion()) return;
  const state = stateOf(el);
  state.channel = channel;
  const now = performance.now();
  const elapsed = Math.max(1, now - (state.lastStep || now));
  state.lastStep = now;
  el.classList.add('is-moving');
  const target = Math.min(1, 0.45 + (distance / elapsed) * 0.8);
  state.strength += (target - state.strength) * 0.5;
  el.style.setProperty(channel.flow, (travelledOf(el, channel) + distance).toFixed(1));
  el.style.setProperty(channel.strength, state.strength.toFixed(3));
  clearTimeout(state.idle);
  state.idle = setTimeout(() => rest(el, state), 140);
}

export function restGlassFlow(el: HTMLElement) {
  rest(el, stateOf(el));
}
