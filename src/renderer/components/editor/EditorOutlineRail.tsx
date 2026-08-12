import {
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
import { useSettingsStore } from '../../store/settings-store';
import { useEditorRailPresentation } from './editor-rail-presentation';

import {
  flattenOutlineEntries,
  layoutOutlineRailLabels,
  outlineActivePathIds,
  planOutlineRail,
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
  clientHeight: number;
  scrollTop: number;
}

interface OmissionReveal {
  label: OutlineRailOmissionLabel;
  rect: DOMRect;
}

const EMPTY_GEOMETRY: RailGeometry = {
  offsets: {},
  fractions: {},
  contentHeight: 1,
  clientHeight: 1,
  scrollTop: 0,
};

const OMISSION_REVEAL_LIMIT = 10;
const OMISSION_REVEAL_WIDTH = 190;

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

export function EditorOutlineRail(props: Props) {
  const outlineRailMode = useSettingsStore((state) => state.outlineRailMode);
  const presentation = useEditorRailPresentation();
  const visible = presentation?.outlineVisible ?? outlineRailMode !== 'hidden';
  if (!visible) return null;
  return <VisibleEditorOutlineRail {...props} labelPitch={presentation?.outlineLabelPitch} />;
}

function VisibleEditorOutlineRail({
  title,
  items,
  activeId,
  onItemClick,
  emptyHint,
  secondaryItems,
  labelPitch,
}: Props & { labelPitch?: number }) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLElement | null>(null);
  const bodyElRef = useRef<HTMLElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const closeRevealTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const [geometry, setGeometry] = useState<RailGeometry>(EMPTY_GEOMETRY);
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
    const update = () => {
      setRailHeight(rail.clientHeight);
    };
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    observer.observe(body);
    update();
    return () => {
      observer.disconnect();
    };
  }, [bodyEl]);

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

  useEffect(() => {
    if (!scrollEl) return undefined;
    scheduleMeasure();
    const onScroll = () => {
      if (scrollFrameRef.current != null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        setGeometry((previous) => {
          const next = {
            ...previous,
            scrollTop: scrollEl.scrollTop,
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
  }, [flatKey, measure, scheduleMeasure, scrollEl]);

  const primaryId = useMemo(
    () =>
      activeId ??
      nearestPrimaryId(flat, geometry.offsets, geometry.scrollTop + geometry.clientHeight * 0.28),
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
  const activePathIds = useMemo(() => outlineActivePathIds(flat, primaryId), [flat, primaryId]);
  const plan = useMemo(
    () => planOutlineRail(flat, primaryId, railHeight, geometry.fractions, labelPitch),
    [flat, geometry.fractions, labelPitch, primaryId, railHeight],
  );
  const laidOut = useMemo(
    () => layoutOutlineRailLabels(plan.labels, railHeight, labelPitch),
    [labelPitch, plan.labels, railHeight],
  );
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    const root = scrollElRef.current;
    if (!root) return;
    event.preventDefault();
    // Keep wheel input over a TOC label connected to the manuscript while
    // preserving the editor's strict vertical axis.
    root.scrollBy({ top: event.deltaY });
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

  const openOmissionReveal = (label: OutlineRailOmissionLabel, target: HTMLElement) => {
    clearRevealClose();
    setOmissionReveal({ label, rect: target.getBoundingClientRect() });
  };

  const jumpToEntry = (id: string) => {
    onItemClick?.(id);
  };

  return (
    <nav
      ref={attachRail}
      className="editor__toc-rail editor__toc-rail--edge is-active"
      aria-label={`${title} · ${t('editorOutline.aria')}`}
      data-density={plan.mode}
      data-placement="edge"
      onWheel={handleWheel}
    >
      <div className="editor__toc-labels">
        {flat.length === 0 && emptyHint && <span className="editor__toc-empty">{emptyHint}</span>}
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
                <span className="editor__toc-tag-branch" aria-hidden>
                  ·
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {omissionReveal && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="editor__toc-omission-reveal editor__toc-omission-reveal--edge"
              role="group"
              aria-label={t('editorOutline.hiddenItems', {
                count: omissionReveal.label.entries.length,
              })}
              style={{
                left: `${Math.min(
                  window.innerWidth - OMISSION_REVEAL_WIDTH - 8,
                  Math.max(8, omissionReveal.rect.left),
                )}px`,
                top: `${Math.min(
                  window.innerHeight - omissionRevealEntries(omissionReveal.label).length * 22 - 12,
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
