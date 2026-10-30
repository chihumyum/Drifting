import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IslePair } from './element-isles-model';

export interface SuperElementIsleLinesProps {
  pairs: readonly IslePair[];
  /** Element centres, world px. */
  centers: ReadonlyMap<string, { x: number; y: number }>;
  /** The world rectangle the lines may fall in, px. */
  bounds: { left: number; top: number; width: number; height: number };
  /** The element under the pointer or in focus: its lines come forward, the rest recede. */
  active: string | null;
  /** While only one element's neighbourhood is shown, the elements still drawn. */
  visible: ReadonlySet<string> | null;
}

// The canvas is world-sized and rides the world transform, so panning and
// zooming never repaint it; its resolution is capped for very large books.
const MAX_PIXELS = 14_000_000;

function grains(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function seedOf(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 + 1;
}

/**
 * A dry sand line along a gentle arc: grains scattered across its width,
 * thinner toward both ends, with the odd gap where the brush lifted. Keyed
 * to the pair, so it never changes between paints.
 */
function sandLine(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  width: number,
  alpha: number,
  seed: number,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (from.x + to.x) / 2 - dy * 0.08;
  const cy = (from.y + to.y) / 2 + dx * 0.08;
  const steps = Math.max(10, Math.floor(len / 1.5));
  const next = grains(seed);
  for (let i = 0; i <= steps; i += 1) {
    if (next() < 0.06) continue;
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * cx + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * cy + t * t * to.y;
    const tx = 2 * u * (cx - from.x) + 2 * t * (to.x - cx);
    const ty = 2 * u * (cy - from.y) + 2 * t * (to.y - cy);
    const tl = Math.hypot(tx, ty) || 1;
    const taper = 0.45 + 0.55 * Math.sin(Math.PI * t);
    for (let j = 0; j < 2; j += 1) {
      const offset = (next() - 0.5) * width * taper;
      ctx.globalAlpha = alpha * (0.3 + next() * 0.7) * taper;
      ctx.fillRect(x - (ty / tl) * offset, y + (tx / tl) * offset, 1.15, 1.15);
    }
  }
  ctx.globalAlpha = 1;
}

function useThemeRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return revision;
}

/** The lines the prose draws between elements, in sand, under the cards. */
export const SuperElementIsleLines = memo(function SuperElementIsleLines({
  pairs, centers, bounds, active, visible,
}: SuperElementIsleLinesProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const theme = useThemeRevision();
  const scale = Math.min(1.5, Math.sqrt(MAX_PIXELS / Math.max(1, bounds.width * bounds.height)));
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, -bounds.left * scale, -bounds.top * scale);
    ctx.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    const most = pairs.reduce((max, pair) => Math.max(max, pair.count), 1);
    for (const pair of pairs) {
      if (visible && (!visible.has(pair.a) || !visible.has(pair.b))) continue;
      const from = centers.get(pair.a);
      const to = centers.get(pair.b);
      if (!from || !to) continue;
      const strength = pair.count / most;
      const touches = active !== null && (pair.a === active || pair.b === active);
      let alpha = 0.16 + strength * 0.46;
      if (active) alpha = touches ? Math.min(0.92, alpha * 1.8) : alpha * 0.12;
      sandLine(ctx, from, to, 1.4 + strength * 5, alpha, seedOf(pair.key));
    }
  }, [pairs, centers, bounds, active, visible, scale, theme]);
  return (
    <canvas
      ref={ref}
      className="se-isle-lines"
      aria-hidden
      width={Math.max(1, Math.round(bounds.width * scale))}
      height={Math.max(1, Math.round(bounds.height * scale))}
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
    />
  );
});
