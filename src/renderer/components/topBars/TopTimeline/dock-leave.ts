// A closed tab leaves the dock the way it came in. Its pill folds back to a
// mark's width and fades where it stood (a mark fades the way its sand
// arrived), while the pills either side, the lock and the plus slide together
// to close the gap, FLIP style: each is moved back to where it stood and
// eased home. All of it runs on the dock pill's duration and curve
// (lib/motion.ts), so the closing pill and its neighbours land together.
import { DOCK_PILL_EASING, DOCK_PILL_MS } from '../../../lib/motion';

/** A dock mark's width: a pill grows from it (dock-pill-grow) and folds back to it. */
export const DOCK_MARK_WIDTH = 20;

interface SlotPlace {
  key: string;
  left: number;
  width: number;
}

interface LeavingSlot extends SlotPlace {
  top: number;
  height: number;
  pill: boolean;
  ghost: HTMLElement;
}

export interface DockSnapshot {
  /** Every slot in the strip, in order, where it stood before the change. */
  slots: SlotPlace[];
  /** Where the controls beside the strip (the lock, the plus) stood. */
  chrome: Map<string, number>;
  /** Still copies of the slots that are about to close. */
  leaving: LeavingSlot[];
}

/** The live animations and copies of one dock, so a new close or an unmount can stop them. */
export interface DockLeaveState {
  moving: Map<Element, Animation>;
  ghosts: Set<HTMLElement>;
}

export function createDockLeaveState(): DockLeaveState {
  return { moving: new Map(), ghosts: new Set() };
}

function slotsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && Boolean(element.dataset.tabKey),
  );
}

/** The lock and the plus: the strip's siblings, keyed by their own class. */
function chromeOf(container: HTMLElement): Map<string, HTMLElement> {
  const chrome = new Map<string, HTMLElement>();
  for (const element of Array.from(container.parentElement?.children ?? [])) {
    if (element === container || !(element instanceof HTMLElement) || element.classList.contains('dock-slot-leaving')) continue;
    const key = element.classList.item(0);
    if (key) chrome.set(key, element);
  }
  return chrome;
}

/** A still, inert copy of a slot that takes no pointer and is skipped by assistive tech. */
function stillCopy(slot: HTMLElement): HTMLElement {
  const copy = slot.cloneNode(true) as HTMLElement;
  for (const name of ['data-tab-key', 'draggable', 'role', 'aria-selected', 'data-glass-awake', 'data-cluster-break', 'title']) {
    copy.removeAttribute(name);
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.classList.add('dock-slot-leaving');
  return copy;
}

/**
 * Read the dock before React changes it: where every slot and control stands
 * (including any slide still under way) and a copy of each slot that is about
 * to close. Returns null when nothing closes.
 */
export function captureDock(container: HTMLElement, nextKeys: ReadonlySet<string>): DockSnapshot | null {
  const elements = slotsOf(container);
  if (elements.every((element) => nextKeys.has(element.dataset.tabKey!))) return null;
  const slots: SlotPlace[] = [];
  const leaving: LeavingSlot[] = [];
  for (const element of elements) {
    const key = element.dataset.tabKey!;
    const rect = element.getBoundingClientRect();
    slots.push({ key, left: rect.left, width: rect.width });
    if (!nextKeys.has(key)) {
      leaving.push({
        key, left: rect.left, width: rect.width, top: rect.top, height: rect.height,
        pill: element.classList.contains('app-tab'), ghost: stillCopy(element),
      });
    }
  }
  const chrome = new Map<string, number>();
  for (const [key, element] of chromeOf(container)) chrome.set(key, element.getBoundingClientRect().left);
  return { slots, chrome, leaving };
}

/**
 * Where a closed slot's neighbours meet once its gap has closed: between the
 * nearest slots that stay on either side, at whichever one there is, or, with
 * none left, the middle of where it stood.
 */
export function closingPoint(
  before: readonly SlotPlace[],
  index: number,
  after: ReadonlyMap<string, { left: number; right: number }>,
): number {
  let previous: number | null = null;
  for (let at = index - 1; at >= 0 && previous === null; at -= 1) previous = after.get(before[at].key)?.right ?? null;
  let next: number | null = null;
  for (let at = index + 1; at < before.length && next === null; at += 1) next = after.get(before[at].key)?.left ?? null;
  if (previous !== null && next !== null) return (previous + next) / 2;
  return previous ?? next ?? before[index].left + before[index].width / 2;
}

/** Move an element back by `dx` and ease it home. */
function slide(element: HTMLElement, dx: number, state: DockLeaveState) {
  // A pill in a drag owns its transform (tab-reorder.ts).
  if (Math.abs(dx) < 0.5 || element.style.transform) return;
  const animation = element.animate(
    [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
    { duration: DOCK_PILL_MS, easing: DOCK_PILL_EASING },
  );
  state.moving.set(element, animation);
  const done = () => { if (state.moving.get(element) === animation) state.moving.delete(element); };
  animation.onfinish = done;
  animation.oncancel = done;
}

/**
 * Lay a closed slot's copy where it stood, inside `host` (the strip's parent,
 * so the strip's scrolling never clips it) positioned against `parent`, and
 * fold it away towards `point`.
 */
function fold(host: HTMLElement, parent: DOMRect, slot: LeavingSlot, point: number, state: DockLeaveState) {
  const { ghost } = slot;
  // The slot's own inline position and minimum width would win over a class.
  ghost.style.position = 'absolute';
  ghost.style.margin = '0';
  ghost.style.minWidth = '0';
  ghost.style.width = `${slot.width}px`;
  ghost.style.height = `${slot.height}px`;
  ghost.style.left = `${slot.left - parent.left}px`;
  ghost.style.top = `${slot.top - parent.top}px`;
  host.append(ghost);
  state.ghosts.add(ghost);
  const timing = { duration: DOCK_PILL_MS, easing: DOCK_PILL_EASING, fill: 'forwards' as const };
  const animation = slot.pill
    // The pill folds back to a mark's width, centred on where its neighbours
    // meet; its title fades first, as it came in last; the glass goes last.
    ? ghost.animate([
      { width: `${slot.width}px`, transform: 'none', opacity: 1 },
      { opacity: 1, offset: 0.4 },
      { width: `${DOCK_MARK_WIDTH}px`, transform: `translateX(${point - DOCK_MARK_WIDTH / 2 - slot.left}px)`, opacity: 0 },
    ], timing)
    // A mark goes the way its sand arrived (sand-arrive), reversed.
    : ghost.animate([
      { transform: 'none', opacity: 1, filter: 'none' },
      { transform: `translateX(${point - slot.width / 2 - slot.left}px) scale(0.8)`, opacity: 0, filter: 'blur(1.6px)' },
    ], timing);
  if (slot.pill) {
    for (const child of Array.from(ghost.children)) {
      child.animate([{ opacity: 1 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }], timing);
    }
  }
  let timer = 0;
  const remove = () => {
    window.clearTimeout(timer);
    ghost.remove();
    state.ghosts.delete(ghost);
  };
  animation.onfinish = remove;
  animation.oncancel = remove;
  // A hidden window runs no animation frames, so its finish event waits for
  // the window to show again; the copy is gone by then all the same.
  timer = window.setTimeout(remove, DOCK_PILL_MS + 100);
}

/** After the change: fold each closed slot away and slide everything else into place. */
export function playDockLeave(container: HTMLElement, snapshot: DockSnapshot, state: DockLeaveState) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const slots = slotsOf(container);
  const chrome = chromeOf(container);
  // A slide still under way from an earlier close starts again from where it
  // had got to (the snapshot read it there), so its own offset goes first.
  for (const element of [...slots, ...chrome.values()]) state.moving.get(element)?.cancel();
  // Every read first, then every write, so the commit lays the dock out once.
  const host = container.parentElement;
  // The copies sit in the strip's parent; it is not positioned, so they are
  // placed against the same ancestor it is.
  const parent = host ? (host.offsetParent ?? document.body).getBoundingClientRect() : null;
  const after = new Map<string, { left: number; right: number }>();
  const moves: Array<[HTMLElement, number]> = [];
  const before = new Map(snapshot.slots.map((slot) => [slot.key, slot.left]));
  for (const element of slots) {
    const rect = element.getBoundingClientRect();
    const key = element.dataset.tabKey!;
    after.set(key, { left: rect.left, right: rect.right });
    const left = before.get(key);
    if (left !== undefined) moves.push([element, left - rect.left]);
  }
  for (const [key, element] of chrome) {
    const left = snapshot.chrome.get(key);
    if (left !== undefined) moves.push([element, left - element.getBoundingClientRect().left]);
  }
  for (const [element, dx] of moves) slide(element, dx, state);
  if (!host || !parent) return;
  for (const slot of snapshot.leaving) {
    const index = snapshot.slots.findIndex((place) => place.key === slot.key);
    fold(host, parent, slot, closingPoint(snapshot.slots, index, after), state);
  }
}

/** Stop every slide and take every copy away (the dock unmounts or changes form). */
export function stopDockLeave(state: DockLeaveState) {
  for (const animation of [...state.moving.values()]) animation.cancel();
  state.moving.clear();
  for (const ghost of [...state.ghosts]) ghost.remove();
  state.ghosts.clear();
}
