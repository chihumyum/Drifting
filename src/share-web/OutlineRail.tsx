import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  flattenOutlineEntries, layoutOutlineRailLabels, outlineActivePathIds, planOutlineRail,
  visibleOutlineIds, type FlatOutlineEntry, type OutlineRailOmissionLabel,
} from '../renderer/components/editor/outline-rail-model';
import { EMPTY_OUTLINE_VIEWPORT, OutlineViewportController } from '../renderer/components/editor/outline-viewport';
import type { ShareBlock } from '../shared/share-document';
import { outlineOf } from './document-outline';
import { t } from './i18n';

const subscribeEmpty = () => () => undefined;
const emptyViewport = () => EMPTY_OUTLINE_VIEWPORT;

/** The editor's tiers for headings: scene, beat, note. */
function tier(entry: FlatOutlineEntry): 'l3' | 'l4' | 'l5' {
  return entry.item.level === 1 ? 'l3' : entry.item.level === 2 ? 'l4' : 'l5';
}

/**
 * The editor's outline rail at the left edge of the reader's scroller: labels
 * sit at their headings' measured places, the reading location in bold ink,
 * dense stretches folded behind an omission handle (EditorOutlineRail).
 */
export function OutlineRail({ blocks }: { blocks: readonly ShareBlock[] }) {
  const flat = useMemo(() => flattenOutlineEntries(outlineOf(blocks)), [blocks]);
  const ids = useMemo(() => flat.map(entry => entry.id), [flat]);
  const [viewport, setViewport] = useState<OutlineViewportController | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [reveal, setReveal] = useState<{ label: OutlineRailOmissionLabel; rect: DOMRect } | null>(null);

  const attach = useCallback((rail: HTMLElement | null) => {
    const body = rail?.closest<HTMLElement>('.reader__body');
    const root = body?.querySelector<HTMLElement>(':scope > .reader__scroll') ?? null;
    setScroller(root);
    setViewport(root && body && rail ? new OutlineViewportController(root, rail, body) : null);
  }, []);
  useLayoutEffect(() => viewport?.attach(), [viewport]);
  useLayoutEffect(() => {
    viewport?.configure(flat, ids);
    viewport?.setPresentationNeeded(true);
  }, [viewport, flat, ids]);
  const { geometry, railHeight, primaryId } = useSyncExternalStore(
    viewport?.subscribe ?? subscribeEmpty,
    viewport?.getSnapshot ?? emptyViewport,
    emptyViewport,
  );
  const visible = useMemo(
    () => visibleOutlineIds(flat, geometry.offsets, geometry.scrollTop, geometry.scrollTop + geometry.clientHeight, geometry.contentHeight),
    [flat, geometry],
  );
  const activePath = useMemo(() => outlineActivePathIds(flat, primaryId), [flat, primaryId]);
  const plan = useMemo(() => planOutlineRail(flat, primaryId, railHeight, geometry.fractions), [flat, geometry.fractions, primaryId, railHeight]);
  const labels = useMemo(() => layoutOutlineRailLabels(plan.labels, railHeight), [plan.labels, railHeight]);

  if (flat.length === 0) return null;

  const jump = (id: string) => {
    setReveal(null);
    viewport?.pin(id);
    const target = scroller?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (!scroller || !target) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 32;
    scroller.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  // Wheel input over a label keeps scrolling the manuscript.
  const wheel = (event: WheelEvent<HTMLElement>) => {
    if (!scroller) return;
    event.preventDefault();
    scroller.scrollBy({ top: event.deltaY });
  };
  // The ten entries nearest the visible ones, as the editor reveals them.
  const revealEntries = reveal
    ? reveal.label.side === 'before' ? reveal.label.entries.slice(-10) : reveal.label.entries.slice(0, 10)
    : [];

  return (
    <nav ref={attach} className="editor__toc-rail" aria-label={t.outline} onWheel={wheel}>
      <div className="editor__toc-labels">
        {labels.map(({ label, y }) => {
          if (label.type === 'omission') {
            return (
              <button
                key={label.key}
                type="button"
                className={`editor__toc-omission${reveal?.label.key === label.key ? ' is-revealing' : ''}`}
                style={{ top: `${y}px` }}
                aria-label={t.hiddenItems(label.entries.length)}
                title={t.hiddenItems(label.entries.length)}
                onPointerEnter={event => setReveal({ label, rect: event.currentTarget.getBoundingClientRect() })}
                onFocus={event => setReveal({ label, rect: event.currentTarget.getBoundingClientRect() })}
              >
                <i className="brush-icon brush-icon--more" style={{ '--brush-icon-size': '12px' } as React.CSSProperties} />
              </button>
            );
          }
          const entry = label.entry;
          const primary = entry.id === primaryId;
          const classes = [
            'editor__toc-tag',
            `editor__toc-tag--${tier(entry)}`,
            visible.has(entry.id) ? 'is-visible' : '',
            primary ? 'is-primary' : '',
            activePath.has(entry.id) ? 'is-active-path' : '',
          ].filter(Boolean).join(' ');
          return (
            <button key={label.key} type="button" className={classes} style={{ top: `${y}px` }} title={entry.item.text}
              aria-current={primary ? 'location' : undefined} onClick={() => jump(entry.id)}>
              <span className="editor__toc-tag-text">{entry.item.text}</span>
            </button>
          );
        })}
      </div>
      {reveal && createPortal(
        <div
          className="editor__toc-reveal"
          role="group"
          aria-label={t.hiddenItems(revealEntries.length)}
          style={{
            left: `${Math.min(window.innerWidth - 188, Math.max(8, reveal.rect.left))}px`,
            top: `${Math.min(window.innerHeight - revealEntries.length * 24 - 16, Math.max(8, reveal.rect.top - (revealEntries.length * 24) / 2))}px`,
          }}
          onPointerLeave={() => setReveal(null)}
        >
          {revealEntries.map(entry => (
            <button key={entry.id} type="button" title={entry.item.text} onClick={() => jump(entry.id)}>{entry.item.text}</button>
          ))}
        </div>,
        document.body,
      )}
    </nav>
  );
}
