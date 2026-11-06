import { useLayoutEffect, useRef, useState } from 'react';
import type { MaterialRegion } from '../../domain/comment';
import { drawSandStroke, paintSandStroke, rgbOfComputedColour, SAND_FRAME_PAD, type SandStroke } from '../../lib/sand-frame';
import type { MediaBox } from './MaterialMediaStage';

export interface RegionMark {
  id: string;
  /** 1-based number shared with the comment list. */
  index: number;
  region: MaterialRegion;
  resolved: boolean;
  todo: boolean;
}

type Rect = Pick<MaterialRegion, 'x' | 'y' | 'w' | 'h'>;

const MIN_REGION = 0.01;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percent(rect: Rect) {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
}

const FRAME_DRAW_MS = 380;

/** A region keeps one stroke for good: the seed comes from its comment. */
function seedOf(id: string) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The dry frame round a region comment, drawn for the region's own size with
 * the brush that frames a selected sidebar cell (lib/sand-frame.ts). It is
 * always there, faint at rest; each time the region is selected the brush
 * goes round it again. Its colour is the canvas's CSS `color` (the comment's
 * or the TODO's), repainted when the theme changes.
 */
function RegionFrame({ id, todo, selected }: { id: string; todo: boolean; selected: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wasSelected = useRef(selected);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const seed = seedOf(id);
    const begin = selected && !wasSelected.current && !reducedMotion() ? performance.now() : -Infinity;
    wasSelected.current = selected;
    let cached: { key: string; stroke: SandStroke } | null = null;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= SAND_FRAME_PAD * 2 || height <= SAND_FRAME_PAD * 2) return;
      // A region can cover a whole page; past a modest size the stroke is
      // drawn at one device pixel per CSS pixel so painting stays cheap.
      const dpr = width * height > 250_000 ? 1 : Math.max(1, window.devicePixelRatio || 1);
      const key = `${width}x${height}@${dpr}`;
      if (cached?.key !== key) {
        cached = { key, stroke: drawSandStroke({ width: width - SAND_FRAME_PAD * 2, height: height - SAND_FRAME_PAD * 2, dpr, seed }) };
      }
      const t = (performance.now() - begin) / FRAME_DRAW_MS;
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
    // The theme and its pigment live on the root element.
    const theme = new MutationObserver(redraw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      theme.disconnect();
    };
  }, [id, todo, selected]);

  return <canvas ref={ref} className="material-region__frame" aria-hidden="true" />;
}

/**
 * Region comments drawn over an image or one PDF page. Lives inside the
 * media's transformed box, so it zooms and pans with the media and stores
 * coordinates normalized to that box.
 */
export function MaterialRegionLayer({
  box,
  marks,
  selectedId,
  linkedId = null,
  drawing,
  onSelect,
  onLink,
  onDrawn,
}: {
  box: MediaBox;
  marks: readonly RegionMark[];
  selectedId: string | null;
  /** The region whose comment the pointer is on. */
  linkedId?: string | null;
  drawing: boolean;
  onSelect: (id: string) => void;
  /** The region under the pointer, or null when it leaves. */
  onLink?: (id: string | null) => void;
  /** A finished rectangle plus a screen point to anchor the composer. */
  onDrawn: (rect: Rect, screen: { x: number; y: number }) => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const visible = marks.filter((mark) => (mark.region.page ?? null) === box.page);

  const toUnit = (event: React.PointerEvent) => {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };
  const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  return (
    <div
      ref={layerRef}
      className={`material-regions${drawing ? ' material-regions--drawing' : ''}`}
      onPointerDown={(event) => {
        if (!drawing || event.button !== 0) return;
        // Drawing owns the pointer; the stage must not start a pan.
        event.stopPropagation();
        event.preventDefault();
        const point = toUnit(event);
        startRef.current = { ...point, pointerId: event.pointerId };
        setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer that is already gone cannot be captured; drawing still
          // follows moves over the layer.
        }
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.stopPropagation();
        setDraft(rectFrom(start, toUnit(event)));
      }}
      onPointerUp={(event) => {
        const start = startRef.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.stopPropagation();
        startRef.current = null;
        const rect = rectFrom(start, toUnit(event));
        setDraft(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (rect.w >= MIN_REGION && rect.h >= MIN_REGION) onDrawn(rect, { x: event.clientX, y: event.clientY });
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {visible.map((mark) => (
        <button
          key={mark.id}
          type="button"
          className={[
            'material-region',
            'material-region--sand',
            mark.id === selectedId ? 'material-region--selected' : '',
            mark.id === linkedId ? 'material-region--linked' : '',
            mark.resolved ? 'material-region--resolved' : '',
            mark.todo ? 'material-region--todo' : '',
          ].filter(Boolean).join(' ')}
          style={percent(mark.region)}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={() => onLink?.(mark.id)}
          onPointerLeave={() => onLink?.(null)}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(mark.id);
          }}
        >
          <RegionFrame id={mark.id} todo={mark.todo} selected={mark.id === selectedId} />
          <span className="material-region__badge material-region__badge--seal">{mark.index}</span>
        </button>
      ))}
      {draft && (
        <div className="material-region material-region--draft material-region--sand" style={percent(draft)} />
      )}
    </div>
  );
}
