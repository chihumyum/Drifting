/**
 * PanelHoverPreview — shared hover card for sidebar list cells (elements /
 * chapters / drifts). A fixed-position, pointer-transparent summary popover
 * anchored to the right of the hovered cell.
 *
 * Presentational only: hover-intent timing + anchor capture live in
 * `useHoverPreview`, which each panel owns so the card unmounts with it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const HOVER_PREVIEW_DELAY_MS = 220;

export interface HoverPreviewPosition {
  top: number;
  left: number;
}

/**
 * Hover-intent state machine: `onEnter(data, cellRect)` arms a short timer
 * (so quick sweeps across the list don't flash cards), `onLeave()` disarms
 * and hides. Returns the armed preview (payload + fixed position) or null.
 */
export function useHoverPreview<T>() {
  const [preview, setPreview] = useState<(HoverPreviewPosition & { data: T }) | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onEnter = useCallback(
    (data: T, rect: DOMRect) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setPreview({ data, top: rect.top, left: rect.right + 8 });
      }, HOVER_PREVIEW_DELAY_MS);
    },
    [clearTimer],
  );

  const onLeave = useCallback(() => {
    clearTimer();
    setPreview(null);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { preview, onEnter, onLeave };
}

export function PanelHoverPreview({
  glyph,
  accentColor,
  title,
  summary,
  top,
  left,
  emptyText = 'No summary',
}: {
  glyph: string;
  accentColor: string;
  title: string;
  summary: string | null | undefined;
  top: number;
  left: number;
  emptyText?: string;
}) {
  const body = summary?.trim() ?? '';
  // Portal to <body>: the sidebars live under `.app-chrome`, whose modern-skin
  // backdrop-filter makes it the containing block for fixed descendants — a
  // non-portaled card gets re-anchored to the chrome and clipped invisible.
  return createPortal(
    <div
      style={{
        position: 'fixed',
        top,
        left,
        width: 260,
        maxHeight: 200,
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule-strong))',
        boxShadow: '0 6px 18px hsl(var(--ink-1) / 0.15)',
        zIndex: 10000,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid hsl(var(--rule) / 0.6)',
          background: 'hsl(var(--paper))',
        }}
      >
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 11,
            color: accentColor,
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'hsl(var(--ink-1))',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title || 'Untitled'}
        </span>
      </div>
      <div
        style={{
          padding: '8px 10px',
          fontSize: 11.5,
          lineHeight: 1.5,
          color: body ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
          fontStyle: body ? 'normal' : 'italic',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 8,
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      >
        {body || emptyText}
      </div>
    </div>,
    document.body,
  );
}
