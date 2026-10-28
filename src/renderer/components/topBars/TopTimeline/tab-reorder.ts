/** Fixed, untransformed slot geometry prevents animated neighbours from
 * changing their own hit targets. The trailing Create tab is not in widths. */
export function projectTabReorder(widths: readonly number[], from: number, left: number) {
  let total = 0;
  const starts = widths.map(width => { const start = total; total += width; return start; });
  const width = widths[from];
  let to = from;
  // Move when the leading edge crosses half of the next slot. Using only
  // source centers would make a wide split unable to pass a narrow end tab.
  if (left > starts[from]) {
    while (to + 1 < widths.length && left + width > starts[to + 1] + widths[to + 1] / 2) to++;
  } else {
    while (to > 0 && left < starts[to - 1] + widths[to - 1] / 2) to--;
  }
  const offsets = widths.map((_, index) => {
    if (index > from && index <= to) return -width;
    if (index < from && index >= to) return width;
    return 0;
  });
  return { to, offsets };
}

export function tabDragScrollSpeed(x: number, width: number) {
  const edge = Math.min(40, width / 4);
  if (x < edge) return -600 * Math.max(0, Math.min(1, (edge - x) / edge));
  if (x > width - edge) return 600 * Math.max(0, Math.min(1, (x - width + edge) / edge));
  return 0;
}

// Tabs move with the weight of the bottom timeline's glass clips: a
// critically damped spring of the same stiffness (chapter-lane-drag.ts).
const SPRING_K = 150;
const SPRING_W = Math.sqrt(SPRING_K);
const SPRING_MS = 520;

/** Progress of the spring at `t` seconds, normalised to land exactly on 1. */
function springProgress(t: number) {
  const settle = 1 - (1 + SPRING_W * SPRING_MS / 1000) * Math.exp(-SPRING_W * SPRING_MS / 1000);
  return (1 - (1 + SPRING_W * t) * Math.exp(-SPRING_W * t)) / settle;
}

/** The spring as a CSS `linear()` easing over SPRING_MS, where supported. */
export function springEasing() {
  const points = Array.from({ length: 25 }, (_, index) =>
    Number(springProgress((index / 24) * SPRING_MS / 1000).toFixed(4)));
  return `linear(${points.join(', ')})`;
}

let easing: string | null = null;
function weightedEasing() {
  if (easing === null) {
    const linear = springEasing();
    easing = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', linear)
      ? linear
      : 'cubic-bezier(0.25, 1, 0.5, 1)';
  }
  return easing;
}

// A blank drag image: the pill itself follows the pointer instead (`Ghost`).
let blankImage: HTMLImageElement | null = null;
function blankDragImage() {
  if (!blankImage && typeof Image !== 'undefined') {
    blankImage = new Image(1, 1);
    blankImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  }
  return blankImage;
}

type Ghost = {
  element: HTMLElement;
  // Where the pill was picked up and where it is now, in client px.
  originX: number;
  originY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  frame: number;
  time: number;
};

type Session = {
  slots: HTMLElement[];
  widths: number[];
  source: HTMLElement;
  from: number;
  to: number;
  grabX: number;
  grabY: number;
  x: number;
  y: number;
  inside: boolean;
  frame: number;
  time: number;
  ghost: Ghost | null;
};

/** Retain HTML drag data for editor split drops and the native cursor image.
 * Only compositor transforms change during a gesture; commit once on drop. */
export function installTabReorder(container: HTMLElement, commit: (from: number, to: number) => void) {
  let session: Session | null = null;
  const animations = new Map<HTMLElement, Animation>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const duration = () => reducedMotion.matches ? 0 : SPRING_MS;
  const slots = () => Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-tab-key][draggable="true"]'));

  function animate(element: HTMLElement, from: string, to: string) {
    animations.get(element)?.cancel();
    animations.delete(element);
    if (!duration() || from === to) return;
    const animation = element.animate([{ transform: from }, { transform: to }], {
      duration: duration(), easing: weightedEasing(),
    });
    animations.set(element, animation);
    animation.onfinish = () => { if (animations.get(element) === animation) animations.delete(element); };
  }

  function shift(element: HTMLElement, x: number) {
    const target = x ? `translateX(${x}px)` : '';
    if (element.style.transform === target) return;
    const current = getComputedStyle(element).transform;
    element.style.transform = target;
    animate(element, current, target || 'none');
  }

  // The picked-up pill follows the pointer on the spring rather than the
  // native drag image, so it lags a little and settles like a heavy block.
  function lift(source: HTMLElement): Ghost | null {
    const host = container.parentElement;
    if (!host || reducedMotion.matches) return null;
    const rect = source.getBoundingClientRect();
    const element = source.cloneNode(true) as HTMLElement;
    for (const name of ['data-tab-key', 'draggable', 'role', 'aria-selected']) element.removeAttribute(name);
    element.setAttribute('aria-hidden', 'true');
    element.classList.add('app-tab--drag-ghost');
    // The tab's own inline `position: relative` would win over the class.
    element.style.position = 'absolute';
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    host.append(element);
    const parent = (element.offsetParent ?? document.body).getBoundingClientRect();
    element.style.left = `${rect.left - parent.left}px`;
    element.style.top = `${rect.top - parent.top}px`;
    const ghost: Ghost = { element, originX: rect.left, originY: rect.top, x: rect.left, y: rect.top,
      vx: 0, vy: 0, frame: 0, time: 0 };
    return ghost;
  }

  function follow(time: number) {
    const drag = session;
    const ghost = drag?.ghost;
    if (!drag || !ghost) return;
    const dt = ghost.time ? Math.min(32, time - ghost.time) / 1000 : 0;
    ghost.time = time;
    const targetX = drag.x - drag.grabX;
    const targetY = drag.y - drag.grabY;
    for (const axis of ['x', 'y'] as const) {
      const v = axis === 'x' ? 'vx' : 'vy';
      const target = axis === 'x' ? targetX : targetY;
      ghost[v] += (-SPRING_K * (ghost[axis] - target) - 2 * SPRING_W * ghost[v]) * dt;
      ghost[axis] += ghost[v] * dt;
    }
    ghost.element.style.transform = `translate(${ghost.x - ghost.originX}px, ${ghost.y - ghost.originY}px)`;
    ghost.frame = requestAnimationFrame(follow);
  }

  function land(ghost: Ghost | null) {
    if (!ghost) return null;
    cancelAnimationFrame(ghost.frame);
    ghost.element.remove();
    return { x: ghost.x, y: ghost.y };
  }

  function isInside(drag: Session) {
    const rect = container.getBoundingClientRect();
    return drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
  }

  function paint(time: number) {
    const drag = session;
    if (!drag) return;
    drag.frame = 0;
    const rect = container.getBoundingClientRect();
    drag.inside = isInside(drag);
    const speed = drag.inside ? tabDragScrollSpeed(drag.x - rect.left, rect.width) : 0;
    const elapsed = drag.time ? Math.min(time - drag.time, 32) : 0;
    drag.time = time;
    const beforeScroll = container.scrollLeft;
    container.scrollLeft += speed * elapsed / 1000;
    const { to, offsets } = projectTabReorder(drag.widths, drag.from,
      drag.x - rect.left + container.scrollLeft - drag.grabX);
    drag.to = drag.inside ? to : drag.from;
    drag.slots.forEach((element, index) => shift(element, drag.inside ? offsets[index] : 0));
    // Opacity preserves the native drag source and its layout/hit box.
    drag.source.style.opacity = drag.inside ? '0' : '0.35';
    if (speed && (elapsed === 0 || container.scrollLeft !== beforeScroll)) drag.frame = requestAnimationFrame(paint);
  }

  function over(event: DragEvent) {
    const drag = session;
    if (!drag) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (isInside(drag)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }
    if (!drag.frame) { drag.time = 0; drag.frame = requestAnimationFrame(paint); }
  }

  function finish(save: boolean, motion = true) {
    const drag = session;
    if (!drag) return;
    session = null;
    cancelAnimationFrame(drag.frame);
    document.removeEventListener('dragover', over);
    document.removeEventListener('dragenter', over);
    document.removeEventListener('drop', drop, true);
    document.removeEventListener('dragend', end);
    document.removeEventListener('dragleave', leave);
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('blur', blur);
    delete container.dataset.tabReordering;
    // The lifted pill hands its place back to the tab, which springs on from
    // wherever the pill had got to: into its new slot, or home on a cancel.
    const landed = land(drag.ghost);
    const before = drag.slots.map(element => element.getBoundingClientRect().left);
    for (const element of drag.slots) {
      animations.get(element)?.cancel();
      animations.delete(element);
      element.style.removeProperty('transform');
    }
    drag.source.style.removeProperty('opacity');
    if (save && drag.to !== drag.from) commit(drag.from, drag.to);
    if (!motion) return;
    drag.slots.forEach((element, index) => {
      if (!element.isConnected) return;
      const rect = element.getBoundingClientRect();
      if (index === drag.from && landed) {
        const dx = landed.x - rect.left;
        const dy = landed.y - rect.top;
        if (dx || dy) animate(element, `translate(${dx}px, ${dy}px)`, 'none');
        return;
      }
      const from = index === drag.from && drag.inside ? drag.x - drag.grabX : before[index];
      const delta = from - rect.left;
      if (delta) animate(element, `translateX(${delta}px)`, 'none');
    });
  }

  function drop(event: DragEvent) {
    if (!session) return;
    over(event);
    cancelAnimationFrame(session.frame);
    paint(performance.now()); // Include the release coordinate even without a final dragover.
    const save = session.inside;
    if (save) event.preventDefault();
    // Outside drops continue to the existing editor split handler.
    finish(save);
  }
  function end() { finish(false); }
  function blur() { finish(false, false); }
  function keydown(event: KeyboardEvent) { if (event.key === 'Escape') finish(false); }
  function leave(event: DragEvent) {
    if (!session || event.relatedTarget !== null) return;
    if (event.target !== document.documentElement && event.target !== document &&
      event.clientX > 0 && event.clientX < window.innerWidth &&
      event.clientY > 0 && event.clientY < window.innerHeight) return;
    // A native drag can leave the entire window without another dragover.
    const drag = session;
    drag.inside = false;
    drag.to = drag.from;
    cancelAnimationFrame(drag.frame);
    drag.frame = 0;
    drag.slots.forEach(element => shift(element, 0));
    drag.source.style.opacity = '0.35';
  }
  function start(event: DragEvent) {
    if (event.defaultPrevented || !event.dataTransfer || !(event.target instanceof Element)) return;
    const source = event.target.closest<HTMLElement>('[data-tab-key][draggable="true"]');
    if (!source || source.parentElement !== container || event.target.closest('button')) return;
    finish(false, false);
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
    const elements = slots();
    const from = elements.indexOf(source);
    if (from < 0) return;
    const rect = source.getBoundingClientRect();
    const key = source.dataset.tabKey!;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    event.dataTransfer.setData('application/x-drifting-tab', key);
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    const ghost = lift(source);
    const image = ghost ? blankDragImage() : null;
    if (image) event.dataTransfer.setDragImage(image, 0, 0);
    else event.dataTransfer.setDragImage(source, grabX, grabY);
    session = { slots: elements, widths: elements.map(element => element.getBoundingClientRect().width),
      source, from, to: from, grabX, grabY, x: event.clientX, y: event.clientY,
      inside: true, frame: requestAnimationFrame(paint), time: 0, ghost };
    if (ghost) ghost.frame = requestAnimationFrame(follow);
    container.dataset.tabReordering = 'true';
    document.addEventListener('dragover', over);
    // Fast native gestures can enter successive label/close descendants without
    // an intervening dragover. Accept and preview on entry as well.
    document.addEventListener('dragenter', over);
    document.addEventListener('drop', drop, true);
    document.addEventListener('dragend', end);
    document.addEventListener('dragleave', leave);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', blur);
  }
  container.addEventListener('dragstart', start);
  return {
    // Cancel if a tab closes, a project switches or widths change mid-gesture.
    invalidate() { finish(false, false); },
    dispose() {
      finish(false, false);
      container.removeEventListener('dragstart', start);
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    },
  };
}
