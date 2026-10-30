/**
 * Which glass rims carry their drift animation (materials.css).
 *
 * A CSS animation costs its element a style update on every frame that
 * anything else in the document animates, even while it is paused. Every
 * glass control and sand cell used to carry a paused `glass-flow` at rest, so
 * a tab switch's selection wave, a sliding sidebar or a hover fade paid for a
 * few hundred of them on each frame.
 *
 * A rim that has never drifted sits at the animation's first frame, which is
 * also its static mask position, so it needs no animation. A control is woken
 * (`data-glass-awake`) when the pointer or focus reaches it, before its rim
 * starts to drift, and goes back to sleep once that changes nothing visible:
 * it is no longer pointed at or focused, and its rim either never moved or is
 * transparent again.
 */

export const GLASS_AWAKE_ATTRIBUTE = 'data-glass-awake';

/** Elements whose rim drifts: glass controls and cells with a ring. */
const RIM_OWNERS = '.glass, :has(> .cell-ring)';
const ENGAGED = ':hover, :focus-within';
/** A little longer than the slowest rim fade (materials.css). */
const SETTLE_MS = 400;

export interface GlassAwakeDocument {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
}

interface GlassAwakeEnvironment {
  getComputedStyle(element: Element, pseudo?: string | null): { opacity: string };
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** The rim owners from `node` up to the root. */
function owners(node: EventTarget | null): Element[] {
  const found: Element[] = [];
  let element = node && typeof (node as Element).matches === 'function' ? node as Element : null;
  for (; element; element = element.parentElement) {
    if (element.matches(RIM_OWNERS)) found.push(element);
  }
  return found;
}

function rimShows(owner: Element, environment: GlassAwakeEnvironment): boolean {
  const ring = owner.classList.contains('glass') ? null : owner.querySelector(':scope > .cell-ring');
  const style = ring ? environment.getComputedStyle(ring) : environment.getComputedStyle(owner, '::before');
  return Number(style.opacity) > 0;
}

function hasDrifted(owner: Element): boolean {
  return owner.getAnimations({ subtree: true }).some((animation) =>
    (animation as CSSAnimation).animationName === 'glass-flow' && Number(animation.currentTime ?? 0) > 0);
}

/** Wake rims under the pointer or focus; let them sleep once nothing would show. */
export function installGlassAwake(
  root: GlassAwakeDocument,
  environment: GlassAwakeEnvironment = window,
): () => void {
  const pending = new Map<Element, number>();

  const wake = (event: Event) => {
    for (const owner of owners(event.target)) {
      const timer = pending.get(owner);
      if (timer !== undefined) {
        environment.clearTimeout(timer);
        pending.delete(owner);
      }
      if (!owner.hasAttribute(GLASS_AWAKE_ATTRIBUTE)) owner.setAttribute(GLASS_AWAKE_ATTRIBUTE, '');
    }
  };

  const trySleep = (owner: Element) => {
    pending.delete(owner);
    if (!owner.isConnected || !owner.hasAttribute(GLASS_AWAKE_ATTRIBUTE) || owner.matches(ENGAGED)) return;
    // A drifted rim that still shows keeps its offset; its fade or a later
    // leave tries again.
    if (hasDrifted(owner) && rimShows(owner, environment)) return;
    owner.removeAttribute(GLASS_AWAKE_ATTRIBUTE);
  };

  const sleepLater = (event: Event) => {
    for (const owner of owners(event.target)) {
      if (!owner.hasAttribute(GLASS_AWAKE_ATTRIBUTE) || pending.has(owner)) continue;
      pending.set(owner, environment.setTimeout(() => trySleep(owner), SETTLE_MS));
    }
  };

  // A rim that faded out after its selection moved away, with no pointer.
  const faded = (event: Event) => {
    if ((event as TransitionEvent).propertyName !== 'opacity') return;
    const target = event.target as Element | null;
    if (!target || typeof target.matches !== 'function') return;
    const owner = target.matches('.cell-ring') ? target.parentElement : target;
    if (owner?.hasAttribute(GLASS_AWAKE_ATTRIBUTE) && !pending.has(owner)) trySleep(owner);
  };

  const listeners: Array<[string, (event: Event) => void]> = [
    ['pointerover', wake],
    ['focusin', wake],
    ['pointerout', sleepLater],
    ['focusout', sleepLater],
    ['transitionend', faded],
  ];
  for (const [type, listener] of listeners) root.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of listeners) root.removeEventListener(type, listener, true);
    for (const timer of pending.values()) environment.clearTimeout(timer);
    pending.clear();
  };
}
