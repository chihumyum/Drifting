import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  drawSandStroke,
  newSandSeed,
  paintSandStroke,
  rgbOfComputedColour,
  SAND_FRAME_PAD,
  type SandStroke,
} from '../../lib/sand-frame';

/** How long the frame fades once the selection moves on (materials.css). */
const FADE_MS = 300;
const DRAW_MS = 380;
const DRAW_DELAY_MS = 60;

/**
 * The brush frame round a selected sand cell (lib/sand-frame.ts), on a canvas
 * that overhangs the cell (materials.css `.cell-frame`). Each new selection
 * is a new stroke, drawn along its path from the mark; a selection that is
 * already held when the cell mounts shows its stroke at once. A resize
 * redraws the same stroke at the new size, and a theme change repaints it in
 * the new colour. Once the selection moves on the frame fades out whole.
 */
export function SandFrame({ selected }: { selected: boolean }) {
  const [shown, setShown] = useState(selected);
  const [settled, setSettled] = useState(selected);
  if (selected && !shown) setShown(true);
  if (settled && !selected) setSettled(false);

  useEffect(() => {
    if (selected || !shown) return undefined;
    const timer = setTimeout(() => setShown(false), FADE_MS);
    return () => clearTimeout(timer);
  }, [selected, shown]);

  return shown ? <SandFrameCanvas selected={selected} settled={settled && selected} /> : null;
}

function SandFrameCanvas({ selected, settled }: { selected: boolean; settled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    // Fading out keeps the last paint.
    if (!canvas || !selected) return undefined;
    const seed = newSandSeed();
    const nominalWidth = canvas.clientWidth - SAND_FRAME_PAD * 2;
    const begin = settled || reducedMotion() ? -Infinity : performance.now();
    let cached: { key: string; stroke: SandStroke } | null = null;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= SAND_FRAME_PAD * 2 || height <= SAND_FRAME_PAD * 2) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const key = `${width}x${height}@${dpr}`;
      if (cached?.key !== key) {
        cached = {
          key,
          stroke: drawSandStroke({ width: width - SAND_FRAME_PAD * 2, height: height - SAND_FRAME_PAD * 2, dpr, seed, nominalWidth }),
        };
      }
      const t = (performance.now() - begin - DRAW_DELAY_MS) / DRAW_MS;
      const progress = t >= 1 ? 1 : t <= 0 ? 0 : 1 - (1 - t) ** 2.2;
      paintSandStroke(canvas, cached.stroke, rgbOfComputedColour(getComputedStyle(canvas).color), progress);
      if (progress < 1) raf = requestAnimationFrame(draw);
    };
    const redraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    draw();
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    const unwatch = watchTheme(redraw);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      unwatch();
    };
  }, [selected, settled]);

  return <canvas ref={ref} className="cell-frame" aria-hidden="true" />;
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// One observer for every frame on screen: the theme and the accent live on
// the root element, and the frame's colour follows them.
const live = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function watchTheme(repaint: () => void) {
  live.add(repaint);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => live.forEach((fn) => fn()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  return () => {
    live.delete(repaint);
    if (!live.size) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
}
