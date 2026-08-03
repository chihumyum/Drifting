import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  flattenOutlineEntries,
  layoutOutlineRailLabels,
  outlineActivePathIds,
  outlineVisibleLabelRange,
  planOutlineRail,
  planOutlineRailPlacement,
  visibleOutlineIds,
  type FlatOutlineEntry,
  type OutlineEntry,
  type OutlineRailOmissionLabel,
} from './outline-rail-model';

interface Props {
  title: string;
  items: OutlineEntry[];
  activeId?: string | null;
  onItemClick?: (id: string) => void;
  emptyHint?: string;
  secondaryItems?: OutlineEntry[];
}

interface RailGeometry {
  offsets: Record<string, number>;
  fractions: Record<string, number>;
  contentHeight: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

interface DragState {
  pointerId: number;
  startY: number;
  startScrollTop: number;
}

interface OmissionReveal {
  label: OutlineRailOmissionLabel;
  rect: DOMRect;
}

const EMPTY_GEOMETRY: RailGeometry = {
  offsets: {},
  fractions: {},
  contentHeight: 1,
  scrollHeight: 1,
  clientHeight: 1,
  scrollTop: 0,
};

const TRACK_INSET = 8;
const MIN_THUMB_PX = 28;
const OMISSION_REVEAL_LIMIT = 10;
const OMISSION_REVEAL_WIDTH = 190;
const SCROLL_ACTIVE_IDLE_MS = 900;
const SEMANTIC_TARGET_IDLE_MS = 1600;
const SEMANTIC_RANGE_MIN_PX = 14;
const SEMANTIC_RANGE_PADDING_PX = 6;

function selectorEscape(value: string): string {
  return typeof CSS !== 'undefined' && 'escape' in CSS
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function resolveAnchor(scrollEl: HTMLElement, entry: FlatOutlineEntry): HTMLElement | null {
  const escaped = selectorEscape(entry.id);
  if (entry.item.kind === 'act') {
    const rawId = entry.id.startsWith('act:') ? entry.id.slice(4) : entry.id;
    return scrollEl.querySelector<HTMLElement>(`[data-act-id="${selectorEscape(rawId)}"]`);
  }
  if (entry.item.kind === 'chapter') {
    return scrollEl.querySelector<HTMLElement>(`[data-chapter-id="${escaped}"]`);
  }
  if (entry.item.kind === 'section') {
    return scrollEl.querySelector<HTMLElement>(`#${escaped}`);
  }
  return (
    scrollEl.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
    scrollEl.querySelector<HTMLElement>(`#${escaped}`)
  );
}

function entryTier(entry: FlatOutlineEntry): 'l1' | 'l2' | 'l3' | 'l4' | 'l5' {
  if (entry.item.kind === 'act') return 'l1';
  if (entry.item.kind === 'chapter' || entry.item.kind === 'section') return 'l2';
  if (entry.item.level === 1) return 'l3';
  if (entry.item.level === 2) return 'l4';
  return 'l5';
}

function sameGeometry(a: RailGeometry, b: RailGeometry): boolean {
  if (
    Math.abs(a.contentHeight - b.contentHeight) > 0.5 ||
    Math.abs(a.scrollHeight - b.scrollHeight) > 0.5 ||
    Math.abs(a.clientHeight - b.clientHeight) > 0.5 ||
    Math.abs(a.scrollTop - b.scrollTop) > 0.5
  ) {
    return false;
  }
  const aKeys = Object.keys(a.offsets);
  const bKeys = Object.keys(b.offsets);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Math.abs(a.offsets[key] - b.offsets[key]) <= 0.5 &&
      Math.abs(a.fractions[key] - b.fractions[key]) <= 0.0005,
  );
}

function nearestPrimaryId(
  flat: FlatOutlineEntry[],
  offsets: Readonly<Record<string, number>>,
  readingLine: number,
): string | null {
  let primary: string | null = null;
  let bestTop = Number.NEGATIVE_INFINITY;
  for (const entry of flat) {
    const top = offsets[entry.id];
    if (Number.isFinite(top) && top <= readingLine && top >= bestTop) {
      primary = entry.id;
      bestTop = top;
    }
  }
  return primary ?? flat[0]?.id ?? null;
}

function omissionRevealEntries(label: OutlineRailOmissionLabel): FlatOutlineEntry[] {
  return label.side === 'before'
    ? label.entries.slice(-OMISSION_REVEAL_LIMIT)
    : label.entries.slice(0, OMISSION_REVEAL_LIMIT);
}

export function EditorOutlineRail({
  title,
  items,
  activeId,
  onItemClick,
  emptyHint,
  secondaryItems,
}: Props) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLElement | null>(null);
  const bodyElRef = useRef<HTMLElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const closeRevealTimerRef = useRef<number | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const semanticTargetTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const [edgeMode, setEdgeMode] = useState(false);
  const [geometry, setGeometry] = useState<RailGeometry>(EMPTY_GEOMETRY);
  const [dragging, setDragging] = useState(false);
  const [scrollActive, setScrollActive] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [semanticTargetId, setSemanticTargetId] = useState<string | null>(null);
  const [omissionReveal, setOmissionReveal] = useState<OmissionReveal | null>(null);

  const flat = useMemo(
    () => flattenOutlineEntries([...items, ...(secondaryItems ?? [])]),
    [items, secondaryItems],
  );
  const flatKey = flat.map((entry) => entry.id).join('|');

  const attachRail = useCallback((element: HTMLElement | null) => {
    railRef.current = element;
    const body = (element?.closest('.editor-body') as HTMLElement | null) ?? null;
    bodyElRef.current = body;
    setBodyEl((previous) => (previous === body ? previous : body));
  }, []);

  useLayoutEffect(() => {
    const body = bodyElRef.current;
    if (!body) return;
    const next = Array.from(body.children).find((child) =>
      child.classList.contains('editor-scroll'),
    );
    const resolved = next instanceof HTMLElement ? next : null;
    scrollElRef.current = resolved;
    const frame = window.requestAnimationFrame(() => setScrollEl(resolved));
    return () => window.cancelAnimationFrame(frame);
  }, [bodyEl]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    const body = bodyElRef.current;
    if (!rail || !body) return undefined;
    let manuscript: HTMLElement | null = null;
    const observeManuscript = () => {
      const next = scrollEl?.querySelector<HTMLElement>('.page') ?? null;
      if (next === manuscript && manuscript?.isConnected) return;
      if (manuscript) observer.unobserve(manuscript);
      manuscript = next;
      if (next) observer.observe(next);
    };
    const update = () => {
      setRailHeight(rail.clientHeight);
      observeManuscript();

      const bodyRect = body.getBoundingClientRect();
      const manuscriptRect = manuscript?.getBoundingClientRect();
      const configuredPageWidth =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--editor-max-width'),
        ) || 720;
      const fallbackPageWidth = Math.min(configuredPageWidth, bodyRect.width);
      const leftGutter = manuscriptRect
        ? Math.max(0, manuscriptRect.left - bodyRect.left)
        : Math.max(0, (bodyRect.width - fallbackPageWidth) / 2);
      const placement = planOutlineRailPlacement(leftGutter);

      body.dataset.outlineRailMode = placement.mode;
      if (placement.mode === 'resident') {
        body.style.setProperty('--editor-toc-rail-left', `${placement.left}px`);
        body.style.setProperty('--editor-toc-rail-width', `${placement.width}px`);
      } else {
        body.style.setProperty('--editor-toc-rail-left', '0px');
        body.style.setProperty('--editor-toc-rail-width', '0px');
      }
      setEdgeMode((previous) => {
        const next = placement.mode === 'edge';
        return previous === next ? previous : next;
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    observer.observe(body);
    if (scrollEl) observer.observe(scrollEl);
    observeManuscript();
    const mutationObserver = scrollEl
      ? new MutationObserver(() => {
          if (manuscript?.isConnected) return;
          observeManuscript();
          update();
        })
      : null;
    if (mutationObserver && scrollEl) {
      mutationObserver.observe(scrollEl, { childList: true, subtree: true });
    }
    update();
    return () => {
      observer.disconnect();
      mutationObserver?.disconnect();
      delete body.dataset.outlineRailMode;
      body.style.removeProperty('--editor-toc-rail-left');
      body.style.removeProperty('--editor-toc-rail-width');
    };
  }, [bodyEl, scrollEl]);

  const measure = useCallback(() => {
    if (!scrollEl) {
      setGeometry(EMPTY_GEOMETRY);
      return;
    }
    const rootRect = scrollEl.getBoundingClientRect();
    const scrollTop = scrollEl.scrollTop;
    const scrollHeight = Math.max(1, scrollEl.scrollHeight);
    const clientHeight = Math.max(1, scrollEl.clientHeight);
    const offsets: Record<string, number> = {};
    const fractions: Record<string, number> = {};

    for (const entry of flat) {
      const anchor = resolveAnchor(scrollEl, entry);
      if (!anchor) continue;
      const top = anchor.getBoundingClientRect().top - rootRect.top + scrollTop;
      offsets[entry.id] = top;
      fractions[entry.id] = Math.min(1, Math.max(0, top / scrollHeight));
    }

    const next: RailGeometry = {
      offsets,
      fractions,
      contentHeight: scrollHeight,
      scrollHeight,
      clientHeight,
      scrollTop,
    };
    setGeometry((previous) => (sameGeometry(previous, next) ? previous : next));
  }, [flat, scrollEl]);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current != null) return;
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  const markScrollActive = useCallback(() => {
    setScrollActive(true);
    if (scrollIdleTimerRef.current != null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setScrollActive(false);
    }, SCROLL_ACTIVE_IDLE_MS);
  }, []);

  useEffect(
    () => () => {
      if (scrollIdleTimerRef.current != null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      if (semanticTargetTimerRef.current != null) {
        window.clearTimeout(semanticTargetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!scrollEl) return undefined;
    scheduleMeasure();
    const onScroll = () => {
      markScrollActive();
      if (scrollFrameRef.current != null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        setGeometry((previous) => {
          const next = {
            ...previous,
            scrollTop: scrollEl.scrollTop,
            scrollHeight: Math.max(1, scrollEl.scrollHeight),
            clientHeight: Math.max(1, scrollEl.clientHeight),
            contentHeight: Math.max(1, scrollEl.scrollHeight),
          };
          return sameGeometry(previous, next) ? previous : next;
        });
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollEl);
    const observeContentChildren = () => {
      Array.from(scrollEl.children).forEach((child) => resizeObserver.observe(child));
    };
    observeContentChildren();
    const mutationObserver = new MutationObserver(() => {
      observeContentChildren();
      scheduleMeasure();
    });
    mutationObserver.observe(scrollEl, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['id', 'data-block-id', 'data-chapter-id', 'data-act-id'],
    });
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (measureFrameRef.current != null) window.cancelAnimationFrame(measureFrameRef.current);
      scrollFrameRef.current = null;
      measureFrameRef.current = null;
    };
  }, [flatKey, markScrollActive, measure, scheduleMeasure, scrollEl]);

  const primaryId = useMemo(
    () =>
      activeId ??
      nearestPrimaryId(
        flat,
        geometry.offsets,
        geometry.scrollTop + geometry.clientHeight * 0.28,
      ),
    [activeId, flat, geometry.clientHeight, geometry.offsets, geometry.scrollTop],
  );
  const visibleIds = useMemo(
    () =>
      visibleOutlineIds(
        flat,
        geometry.offsets,
        geometry.scrollTop,
        geometry.scrollTop + geometry.clientHeight,
        geometry.contentHeight,
      ),
    [flat, geometry],
  );
  const activePathIds = useMemo(
    () => outlineActivePathIds(flat, primaryId),
    [flat, primaryId],
  );
  const plan = useMemo(
    () => planOutlineRail(flat, primaryId, railHeight, geometry.fractions),
    [flat, geometry.fractions, primaryId, railHeight],
  );
  const laidOut = useMemo(
    () => layoutOutlineRailLabels(plan.labels, railHeight),
    [plan.labels, railHeight],
  );
  const semanticRange = useMemo(() => {
    const targetRange = semanticTargetId
      ? outlineVisibleLabelRange(laidOut, new Set([semanticTargetId]))
      : null;
    return targetRange ?? outlineVisibleLabelRange(laidOut, visibleIds);
  }, [laidOut, semanticTargetId, visibleIds]);

  useEffect(() => {
    if (!semanticTargetId || !visibleIds.has(semanticTargetId)) return undefined;
    const target = semanticTargetId;
    if (semanticTargetTimerRef.current != null) {
      window.clearTimeout(semanticTargetTimerRef.current);
      semanticTargetTimerRef.current = null;
    }
    const frame = window.requestAnimationFrame(() => {
      setSemanticTargetId((current) => (current === target ? null : current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [semanticTargetId, visibleIds]);

  const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  const trackHeight = Math.max(0, railHeight - TRACK_INSET * 2);
  const thumbHeight =
    maxScroll === 0
      ? trackHeight
      : Math.min(
          trackHeight,
          Math.max(MIN_THUMB_PX, (geometry.clientHeight / geometry.scrollHeight) * trackHeight),
        );
  const thumbTravel = Math.max(0, trackHeight - thumbHeight);
  const thumbTop =
    TRACK_INSET + (maxScroll > 0 ? (geometry.scrollTop / maxScroll) * thumbTravel : 0);
  let semanticRangeTop = 0;
  let semanticRangeHeight = 0;
  if (semanticRange && railHeight > TRACK_INSET * 2) {
    semanticRangeTop = Math.max(TRACK_INSET, semanticRange.firstY - SEMANTIC_RANGE_PADDING_PX);
    const bottom = Math.min(
      railHeight - TRACK_INSET,
      semanticRange.nextY == null
        ? railHeight - TRACK_INSET
        : semanticRange.nextY - SEMANTIC_RANGE_PADDING_PX,
    );
    semanticRangeHeight = Math.max(SEMANTIC_RANGE_MIN_PX, bottom - semanticRangeTop);
    if (semanticRangeTop + semanticRangeHeight > railHeight - TRACK_INSET) {
      semanticRangeTop = Math.max(
        TRACK_INSET,
        railHeight - TRACK_INSET - semanticRangeHeight,
      );
    }
  }

  const setScrollFromTrackY = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      const root = scrollElRef.current;
      if (!rail || !root || maxScroll <= 0) return;
      const rect = rail.getBoundingClientRect();
      const localY = clientY - rect.top - TRACK_INSET - thumbHeight / 2;
      root.scrollTop =
        (Math.min(thumbTravel, Math.max(0, localY)) / Math.max(1, thumbTravel)) * maxScroll;
    },
    [maxScroll, thumbHeight, thumbTravel],
  );

  const handleTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const root = scrollElRef.current;
    if (event.button !== 0 || !root) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (!target.closest('.editor__toc-thumb')) setScrollFromTrackY(event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: root.scrollTop,
    };
    setDragging(true);
  };

  const handleTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = scrollElRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !root || maxScroll <= 0) return;
    const delta = event.clientY - drag.startY;
    root.scrollTop = drag.startScrollTop + (delta / Math.max(1, thumbTravel)) * maxScroll;
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const handleTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = scrollElRef.current;
    if (!root) return;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = root.scrollTop - 48;
    if (event.key === 'ArrowDown') next = root.scrollTop + 48;
    if (event.key === 'PageUp') next = root.scrollTop - root.clientHeight * 0.85;
    if (event.key === 'PageDown') next = root.scrollTop + root.clientHeight * 0.85;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = maxScroll;
    if (next == null) return;
    event.preventDefault();
    root.scrollTop = Math.min(maxScroll, Math.max(0, next));
  };

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    const root = scrollElRef.current;
    if (!root) return;
    event.preventDefault();
    root.scrollBy({ top: event.deltaY, left: event.deltaX });
  };

  const clearRevealClose = useCallback(() => {
    if (closeRevealTimerRef.current == null) return;
    window.clearTimeout(closeRevealTimerRef.current);
    closeRevealTimerRef.current = null;
  }, []);
  const scheduleRevealClose = useCallback(() => {
    clearRevealClose();
    closeRevealTimerRef.current = window.setTimeout(() => {
      closeRevealTimerRef.current = null;
      setOmissionReveal(null);
    }, 140);
  }, [clearRevealClose]);
  useEffect(
    () => () => {
      clearRevealClose();
    },
    [clearRevealClose],
  );

  const railActive = scrollActive || dragging || interacting || omissionReveal != null;
  useLayoutEffect(() => {
    const body = bodyElRef.current;
    if (!body) return undefined;
    body.dataset.outlineRailActive = railActive ? 'true' : 'false';
    return () => {
      delete body.dataset.outlineRailActive;
    };
  }, [bodyEl, railActive]);

  const openOmissionReveal = (
    label: OutlineRailOmissionLabel,
    target: HTMLElement,
  ) => {
    clearRevealClose();
    setOmissionReveal({ label, rect: target.getBoundingClientRect() });
  };

  const resolvedEmptyHint = emptyHint ?? t('editorOutline.emptyHint');
  const jumpToEntry = (id: string) => {
    setSemanticTargetId(id);
    if (semanticTargetTimerRef.current != null) {
      window.clearTimeout(semanticTargetTimerRef.current);
    }
    semanticTargetTimerRef.current = window.setTimeout(() => {
      semanticTargetTimerRef.current = null;
      setSemanticTargetId(null);
    }, SEMANTIC_TARGET_IDLE_MS);
    onItemClick?.(id);
  };

  return (
    <nav
      ref={attachRail}
      className={`editor__toc-rail editor__toc-rail--${edgeMode ? 'edge' : 'resident'}${
        dragging ? ' is-dragging' : ''
      }${scrollActive ? ' is-scroll-active' : ''}${railActive ? ' is-active' : ''}`}
      aria-label={`${title} · ${t('editorOutline.aria')}`}
      data-density={plan.mode}
      data-placement={edgeMode ? 'edge' : 'resident'}
      onWheel={handleWheel}
      onPointerEnter={() => setInteracting(true)}
      onPointerLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setInteracting(false);
        }
      }}
    >
      <div className="editor__toc-labels">
        {flat.length === 0 && <span className="editor__toc-empty">{resolvedEmptyHint}</span>}
        {laidOut.map(({ label, y }) => {
          const style = { top: `${y}px` };

          if (label.type === 'omission') {
            return (
              <button
                key={label.key}
                type="button"
                className={`editor__toc-omission${
                  omissionReveal?.label.key === label.key ? ' is-revealing' : ''
                }`}
                style={style}
                aria-label={t('editorOutline.hiddenItems', { count: label.entries.length })}
                title={t('editorOutline.hiddenItems', { count: label.entries.length })}
                onPointerEnter={(event) => openOmissionReveal(label, event.currentTarget)}
                onPointerLeave={scheduleRevealClose}
                onFocus={(event) => openOmissionReveal(label, event.currentTarget)}
                onBlur={scheduleRevealClose}
              >
                <span aria-hidden>…</span>
              </button>
            );
          }

          const entry = label.entry;
          const tier = entryTier(entry);
          const visible = visibleIds.has(entry.id);
          const primary = entry.id === primaryId;
          const onActivePath = activePathIds.has(entry.id);
          const classes = [
            'editor__toc-tag',
            `editor__toc-tag--${tier}`,
            visible ? 'is-visible' : '',
            primary ? 'is-primary' : '',
            onActivePath ? 'is-active-path' : '',
            entry.item.children?.length ? 'has-children' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={label.key}
              type="button"
              className={classes}
              style={style}
              onClick={() => jumpToEntry(entry.id)}
              aria-current={primary ? 'location' : undefined}
              title={entry.item.text}
            >
              {entry.item.num && <span className="editor__toc-tag-num">{entry.item.num}</span>}
              <span className="editor__toc-tag-text">{entry.item.text}</span>
              {entry.item.children?.length ? (
                <span className="editor__toc-tag-branch" aria-hidden>·</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        className="editor__toc-track"
        role="scrollbar"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.round(maxScroll)}
        aria-valuenow={Math.round(Math.min(maxScroll, geometry.scrollTop))}
        aria-label={t('editorOutline.scrollbar')}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onKeyDown={handleTrackKeyDown}
      >
        {semanticRange && semanticRangeHeight > 0 ? (
          <span
            className="editor__toc-viewport-range"
            style={{
              top: `${semanticRangeTop}px`,
              height: `${semanticRangeHeight}px`,
            }}
            data-visible-count={semanticRange.count}
            aria-hidden
          />
        ) : null}
        <span
          className="editor__toc-thumb"
          style={{ top: `${thumbTop}px`, height: `${thumbHeight}px` }}
          aria-hidden
        />
      </div>

      {omissionReveal && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`editor__toc-omission-reveal${
                edgeMode ? ' editor__toc-omission-reveal--edge' : ''
              }`}
              role="group"
              aria-label={t('editorOutline.hiddenItems', {
                count: omissionReveal.label.entries.length,
              })}
              style={{
                left: `${
                  edgeMode
                    ? Math.min(
                        window.innerWidth - OMISSION_REVEAL_WIDTH - 8,
                        Math.max(8, omissionReveal.rect.left),
                      )
                    : Math.max(8, omissionReveal.rect.right - OMISSION_REVEAL_WIDTH)
                }px`,
                top: `${Math.min(
                  window.innerHeight -
                    omissionRevealEntries(omissionReveal.label).length * 22 -
                    12,
                  Math.max(
                    8,
                    omissionReveal.rect.top -
                      (omissionRevealEntries(omissionReveal.label).length * 22) / 2,
                  ),
                )}px`,
              }}
              onPointerEnter={clearRevealClose}
              onPointerLeave={scheduleRevealClose}
            >
              {omissionRevealEntries(omissionReveal.label).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`editor__toc-reveal-item editor__toc-reveal-item--${entryTier(entry)}`}
                  title={entry.item.text}
                  onClick={() => {
                    setOmissionReveal(null);
                    jumpToEntry(entry.id);
                  }}
                >
                  {entry.item.text}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </nav>
  );
}
