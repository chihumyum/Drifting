import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MaterialRegion } from '../../domain/comment';
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

/**
 * Region comments drawn over an image or one PDF page. Lives inside the
 * media's transformed box, so it zooms and pans with the media and stores
 * coordinates normalized to that box.
 */
export function MaterialRegionLayer({
  box,
  marks,
  selectedId,
  drawing,
  onSelect,
  onDrawn,
}: {
  box: MediaBox;
  marks: readonly RegionMark[];
  selectedId: string | null;
  drawing: boolean;
  onSelect: (id: string) => void;
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
            mark.id === selectedId ? 'material-region--selected' : '',
            mark.resolved ? 'material-region--resolved' : '',
            mark.todo ? 'material-region--todo' : '',
          ].filter(Boolean).join(' ')}
          style={percent(mark.region)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(mark.id);
          }}
        >
          <span className="material-region__badge">{mark.index}</span>
        </button>
      ))}
      {draft && <div className="material-region material-region--draft" style={percent(draft)} />}
    </div>
  );
}

/** A floating composer for a just-drawn region (portaled, fixed). */
export function RegionCommentComposer({
  anchor,
  onSubmit,
  onCancel,
}: {
  anchor: { x: number; y: number };
  onSubmit: (body: string, asTodo: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [asTodo, setAsTodo] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => ({ left: anchor.x + 12, top: anchor.y + 12 }));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.x + 12, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchor.y + 12, window.innerHeight - height - 12)),
    });
  }, [anchor.x, anchor.y]);

  const submit = () => {
    if (body.trim()) onSubmit(body.trim(), asTodo);
  };
  return createPortal(
    <div ref={ref} className="region-composer" style={position} role="dialog" aria-label={t('materialEditor.regions.compose')}>
      <textarea
        autoFocus
        value={body}
        placeholder={t('materialEditor.regions.placeholder')}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="region-composer__actions">
        <label>
          <input type="checkbox" checked={asTodo} onChange={(event) => setAsTodo(event.target.checked)} />
          {t('materialEditor.regions.asTodo')}
        </label>
        <span className="region-composer__spacer" />
        <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="region-composer__save" disabled={!body.trim()} onClick={submit}>
          {t('materialEditor.regions.save')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
