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
// A wait that ends counts only after this, so its drops keep their rhythm.
const HANDOVER_MS = 80;
// The longest an ebb lasts; a single press is still water in about five seconds.
const EBB_LIMIT_MS = 8000;
// Panels the last rings pass under while the sea ebbs beneath the workspace.
const EBB_VEILS = '.desktop-app-shell .sidebar-shell:not(.is-fully-hidden)';

/**
 * live: a page lies on the sea or a wait holds it. ebb: the last hold let go
 * (a wait opened the workspace); the rings already out run their course under
 * it, untouchable, then the sea goes off. off: hidden, computing nothing.
 */
type SeaMode = 'off' | 'live' | 'ebb';

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
 * (lib/char-sea/char-sea.ts). It is live while a full-window wait or the shelf
 * holds it; when a wait opens the workspace it ebbs there (char-sea.css clears
 * the workspace's desk meanwhile), and it computes nothing while still.
 */
export function CharSea() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sea = useRef<CharSeaHandle | null>(null);
  const holds = useSyncExternalStore(charSeaRegistry.subscribe, charSeaRegistry.getHolds, charSeaRegistry.getHolds);
  const held = holds.loading > 0 || holds.surfaces > 0;
  const [mode, setMode] = useState<SeaMode>(held ? 'live' : 'off');
  // A hold makes it live at once; losing every hold lets it ebb. A hand-over
  // within one commit goes live → ebb → live before paint, the water untouched.
  if (held && mode !== 'live') setMode('live');
  if (!held && mode === 'live') setMode('ebb');
  const active = mode !== 'off';
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
  useLayoutEffect(() => {
    if (mode === 'live') sea.current?.live();
    if (mode !== 'ebb') return undefined;
    const root = document.documentElement;
    root.dataset.charSea = 'ebb';
    const still = () => setMode((current) => (current === 'ebb' ? 'off' : current));
    if (sea.current) sea.current.ebb(still);
    else queueMicrotask(still);
    // A hidden window draws no frames, so its water never stills: put it away anyway.
    const fallback = window.setTimeout(still, EBB_LIMIT_MS);
    return () => {
      window.clearTimeout(fallback);
      delete root.dataset.charSea;
    };
  }, [mode]);

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
  // or opens a book. Dialogs and menus over the page are not the sea, and an
  // ebbing sea is no longer touched.
  useEffect(() => {
    if (mode !== 'live') return undefined;
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
  }, [mode]);

  // Glass on the page, measured where it is now: after it registers, hovers,
  // scrolls or the window changes size. While the sea ebbs under the
  // workspace, its sidebars veil it as the shelf's cards do. Measured before
  // paint, so no frame passes without them.
  useLayoutEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const height = window.innerHeight;
      const shapes: CharSeaShape[] = [];
      if (mode === 'ebb') {
        document.querySelectorAll<HTMLElement>(EBB_VEILS).forEach((panel, index) => {
          const rect = panel.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          shapes.push({
            id: -1 - index, x: rect.left, y: rect.top, width: rect.width, height: rect.height,
            radius: 0, rest: -1, hover: false, textureX: 0, textureY: 0,
          });
        });
      }
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
    sync();
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
  }, [active, mode]);

  return (
    <div className={`char-sea${active ? ' char-sea--active' : ''}`} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
