import {
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../store/settings-store';
import { useEditorRailPresentation } from './editor-rail-presentation';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';
import { EMPTY_OUTLINE_VIEWPORT, OutlineViewportController } from './outline-viewport';

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
  scrollspyIds?: readonly string[];
  onItemClick?: (id: string) => void;
  emptyHint?: string;
  secondaryItems?: OutlineEntry[];
}

interface OmissionReveal {
  label: OutlineRailOmissionLabel;
  rect: DOMRect;
}

const subscribeEmpty = () => () => undefined;
const emptyViewport = () => EMPTY_OUTLINE_VIEWPORT;

const OMISSION_REVEAL_LIMIT = 10;
const OMISSION_REVEAL_WIDTH = 190;

function entryTier(entry: FlatOutlineEntry): 'l1' | 'l2' | 'l3' | 'l4' | 'l5' {
  if (entry.item.kind === 'act') return 'l1';
  if (entry.item.kind === 'chapter' || entry.item.kind === 'section') return 'l2';
  if (entry.item.level === 1) return 'l3';
  if (entry.item.level === 2) return 'l4';
  return 'l5';
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
  return (
    <VisibleEditorOutlineRail
      {...props}
      labelPitch={presentation?.outlineLabelPitch}
      portalTargetId={presentation?.outlinePortalTargetId}
    />
  );
}

function VisibleEditorOutlineRail({
  title,
  items,
  activeId,
  scrollspyIds,
  onItemClick,
  emptyHint,
  secondaryItems,
  labelPitch,
  portalTargetId,
}: Props & { labelPitch?: number; portalTargetId?: string }) {
  const { t } = useTranslation();
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const scrollElRef = useRef<HTMLElement | null>(null);
  const closeRevealTimerRef = useRef<number | null>(null);
  const [omissionReveal, setOmissionReveal] = useState<OmissionReveal | null>(null);
  const [revealVisible, setRevealVisible] = useState(isVisible);
  // A body portal outlives the hidden DOM ancestry. Discard its transient state
  // in this render transition, so neither hiding nor returning reopens it.
  if (revealVisible !== isVisible) {
    setRevealVisible(isVisible);
    if (!isVisible) setOmissionReveal(null);
  }
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<OutlineViewportController | null>(null);

  useLayoutEffect(() => {
    setPortalTarget(portalTargetId ? document.getElementById(portalTargetId) : null);
  }, [portalTargetId]);
  const flat = useMemo(
    () => flattenOutlineEntries([...items, ...(secondaryItems ?? [])]),
    [items, secondaryItems],
  );

  const attachRail = useCallback((rail: HTMLElement | null) => {
    const body = rail?.closest<HTMLElement>('.editor-body');
    const root = body && Array.from(body.children).find(child => child.classList.contains('editor-scroll'));
    const resolved = root instanceof HTMLElement ? root : null;
    scrollElRef.current = resolved;
    setViewport(resolved && body && rail ? new OutlineViewportController(resolved, rail, body) : null);
  }, []);
  useLayoutEffect(() => viewport?.attach(), [viewport]);
  useLayoutEffect(() => {
    viewport?.configure(flat, scrollspyIds);
    viewport?.setPresentationNeeded(isVisible || isPreparing);
  }, [viewport, flat, scrollspyIds, isVisible, isPreparing]);
  const { geometry, railHeight, primaryId: readingId } = useSyncExternalStore(
    viewport?.subscribe ?? subscribeEmpty,
    viewport?.getSnapshot ?? emptyViewport,
    emptyViewport,
  );

  const primaryId = useMemo(
    () =>
      activeId ?? (scrollspyIds ? readingId :
      nearestPrimaryId(flat, geometry.offsets, geometry.scrollTop + geometry.clientHeight * 0.28)),
    [activeId, flat, geometry.clientHeight, geometry.offsets, geometry.scrollTop, readingId, scrollspyIds],
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

  useLayoutEffect(() => {
    if (isVisible) return;
    clearRevealClose();
  }, [isVisible, clearRevealClose]);

  const openOmissionReveal = (label: OutlineRailOmissionLabel, target: HTMLElement) => {
    clearRevealClose();
    setOmissionReveal({ label, rect: target.getBoundingClientRect() });
  };

  const jumpToEntry = (id: string) => {
    viewport?.pin(id);
    onItemClick?.(id);
  };

  const mobileList = portalTarget && isVisible
    ? createPortal(
        <nav className="m-outline-sheet-list" aria-label={`${title} · ${t('editorOutline.aria')}`}>
          {flat.length === 0 && emptyHint ? (
            <span className="m-outline-sheet-list__empty">{emptyHint}</span>
          ) : null}
          {flat.map((entry) => {
            const tier = entryTier(entry);
            const primary = entry.id === primaryId;
            return (
              <button
                key={entry.id}
                type="button"
                className={`m-outline-sheet-list__item m-outline-sheet-list__item--${tier}`}
                aria-current={primary ? 'location' : undefined}
                onClick={() => jumpToEntry(entry.id)}
              >
                {entry.item.num ? <span>{entry.item.num}</span> : null}
                <strong>{entry.item.text}</strong>
              </button>
            );
          })}
        </nav>,
        portalTarget,
      )
    : null;

  return (
    <>
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

      {omissionReveal && isVisible && typeof document !== 'undefined'
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
      {mobileList}
    </>
  );
}
