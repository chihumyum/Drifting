import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../styles/char-sea.css';
import { createCharSea, type CharSea as CharSeaHandle, type CharSeaShape } from '../../lib/char-sea/char-sea';
import { charSeaRegistry } from '../../lib/char-sea/char-sea-registry';
import { charSeaScript } from '../../lib/char-sea/char-sea-text';
import { LOADING_DELAY_MS } from '../../lib/motion';

// Where `.glass:nth-of-type(4n + k)` starts its texture (materials.css), so a
// rim the sea draws is cut the way the same card's CSS rim was.
const GLASS_TEXTURE_OFFSETS = [[-14, -46], [-96, -132], [-168, -18], [-58, -186]] as const;
const PULSE_PERIOD_MS = 1100;
// A wait that starts this soon after a press drops from where the press was.
const PRESS_ORIGIN_MS = 2000;
const INTERACTIVE =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [contenteditable=""], [contenteditable="true"]';
const OVERLAY = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

// A page handing the sea to the next (the shelf to the wait for the book it
// opened, one wait to the next) lets go and takes hold in the same commit.
// A hold that ends counts only after this, so the water and the drops carry on.
const HANDOVER_MS = 80;

function useHandedOver(value: boolean): boolean {
  const [held, setHeld] = useState(value);
  if (value && !held) setHeld(true);
  useEffect(() => {
    if (value) return undefined;
    const timer = window.setTimeout(() => setHeld(false), HANDOVER_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return value || held;
}

/**
 * The sea of characters, once, under the whole desktop window
 * (lib/char-sea/char-sea.ts). It is on while a full-window wait or the shelf
 * holds it, and computes nothing while its water is still.
 */
export function CharSea() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sea = useRef<CharSeaHandle | null>(null);
  const holds = useSyncExternalStore(charSeaRegistry.subscribe, charSeaRegistry.getHolds, charSeaRegistry.getHolds);
  const active = useHandedOver(holds.loading > 0 || holds.surfaces > 0);
  const loading = useHandedOver(holds.loading > 0);
  const { i18n } = useTranslation();
  const script = charSeaScript(i18n.language);

  // Made, coloured and switched on before paint, so the first frame shows it.
  useLayoutEffect(() => {
    if (!canvas.current) return undefined;
    const handle = createCharSea(canvas.current);
    if (!handle) return undefined;
    sea.current = handle;
    const theme = new MutationObserver(() => handle.refreshTheme());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-color-scheme'] });
    const resize = () => handle.resize();
    window.addEventListener('resize', resize);
    return () => {
      theme.disconnect();
      window.removeEventListener('resize', resize);
      handle.destroy();
      sea.current = null;
    };
  }, []);

  useLayoutEffect(() => sea.current?.setScript(script), [script]);
  useLayoutEffect(() => sea.current?.setActive(active), [active]);

  // A wait that outlasts the loading delay: drops fall from where the author
  // pressed (the book they opened) or from the middle, until it ends.
  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setTimeout(() => {
      const press = charSeaRegistry.recentPress(PRESS_ORIGIN_MS);
      const origin = press ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const delay = press ? Math.max(0, PULSE_PERIOD_MS - (performance.now() - press.at)) : 0;
      sea.current?.pulse(origin, PULSE_PERIOD_MS, delay);
    }, LOADING_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      sea.current?.pulse(null);
    };
  }, [loading]);

  // The hand: a light wake as it moves, a ring where it presses the bare desk
  // or opens a book. Dialogs and menus over the page are not the sea.
  useEffect(() => {
    if (!active) return undefined;
    const move = (event: PointerEvent) => sea.current?.wake(event.clientX, event.clientY);
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(OVERLAY)) return;
      const book = target.closest('[data-char-sea-press]');
      if (!book && target.closest(INTERACTIVE)) return;
      sea.current?.drop(event.clientX, event.clientY, book ? 1.3 : 1.2);
      charSeaRegistry.notePress(event.clientX, event.clientY);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', down, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, { capture: true });
    };
  }, [active]);

  // Glass on the page, measured where it is now: after it registers, hovers,
  // scrolls or the window changes size.
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const height = window.innerHeight;
      const shapes: CharSeaShape[] = [];
      charSeaRegistry.shapes().forEach((entry, order) => {
        const rect = entry.element.getBoundingClientRect();
        if (rect.bottom < -24 || rect.top > height + 24 || rect.width <= 0) return;
        const [textureX, textureY] = GLASS_TEXTURE_OFFSETS[order % GLASS_TEXTURE_OFFSETS.length];
        shapes.push({
          id: entry.id, x: rect.left, y: rect.top, width: rect.width, height: rect.height,
          radius: entry.options.radius, rest: entry.options.rest, hover: entry.hover, textureX, textureY,
        });
      });
      sea.current?.setShapes(shapes);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    schedule();
    const stopShapes = charSeaRegistry.onShapes(schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      stopShapes();
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      sea.current?.setShapes([]);
    };
  }, [active]);

  return (
    <div className={`char-sea${active ? ' char-sea--active' : ''}`} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
