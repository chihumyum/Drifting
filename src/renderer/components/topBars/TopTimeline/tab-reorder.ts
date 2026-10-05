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

type Session = {
  slots: HTMLElement[];
  widths: number[];
  source: HTMLElement;
  from: number;
  to: number;
  grabX: number;
  x: number;
  y: number;
  inside: boolean;
  frame: number;
  time: number;
};

/** Retain HTML drag data for editor split drops and the native cursor image.
 * Only compositor transforms change during a gesture; commit once on drop. */
export function installTabReorder(container: HTMLElement, commit: (from: number, to: number) => void) {
  let session: Session | null = null;
  const animations = new Map<HTMLElement, Animation>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const duration = () => reducedMotion.matches ? 0 : 160;
  const slots = () => Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-tab-key][draggable="true"]'));

  function animate(element: HTMLElement, from: string, to: string) {
    animations.get(element)?.cancel();
    animations.delete(element);
    if (!duration() || from === to) return;
    const animation = element.animate([{ transform: from }, { transform: to }], {
      duration: duration(), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
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
      const from = index === drag.from && drag.inside ? drag.x - drag.grabX : before[index];
      const delta = from - element.getBoundingClientRect().left;
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
    event.dataTransfer.setDragImage(source, event.clientX - rect.left, event.clientY - rect.top);
    session = { slots: elements, widths: elements.map(element => element.getBoundingClientRect().width),
      source, from, to: from, grabX: event.clientX - rect.left, x: event.clientX, y: event.clientY,
      inside: true, frame: requestAnimationFrame(paint), time: 0 };
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
