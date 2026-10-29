import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommentTargetKind } from '../../domain/comment';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { selectCommentHighlight } from '../../lib/comment-highlight';
import { flashBlock } from '../../lib/scroll-to-block';
import { getPlatformRuntime } from '../../platform/runtime';
import { isProseEntityType } from '../../lib/yjs-doc-id';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';
import { createAgentMarkerSelector, createCommentMarkerSelector, EMPTY_SCROLL_MARKERS, scrollMarkerBlockSelector, scrollMarkerSeal, type ScrollMarkerTick } from './scroll-marker-model';
import { ScrollMarkerViewportController } from './scroll-marker-viewport';

interface EditorScrollMarkersProps {
  scrollEl: HTMLElement | null;
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  /** Only explicitly mounted sticky notes receive comment ticks. */
  visibleCommentIds?: readonly string[];
}
const NO_VISIBLE_COMMENT_IDS: readonly string[] = [];
const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => EMPTY_SCROLL_MARKERS;
const NO_TICKS: readonly ScrollMarkerTick[] = [];
// Must match the seal's opacity transition in comments-review.css.
const LEAVE_MS = 300;

/** Clickable overview ticks overlay the native scrollbar outside .editor-scroll.
 * Each is a sand seal pressed once (its shape and turn fixed by its key); a
 * tick that goes (a change the author has seen) stays a moment to fade out.
 * Agent ticks remain independent of sticky-note rail membership. Hidden or
 * empty surfaces own no layout listeners; canonical review stays mounted. */
export function EditorScrollMarkers({ scrollEl, projectId, targetKind, targetId,
  visibleCommentIds = NO_VISIBLE_COMMENT_IDS }: EditorScrollMarkersProps) {
  const { t } = useTranslation();
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const selectComments = useMemo(() => createCommentMarkerSelector(projectId, targetKind, targetId, visibleCommentIds),
    [projectId, targetKind, targetId, visibleCommentIds]);
  const comments = useDataStore(selectComments);
  const selectAgent = useMemo(() => {
    const select = createAgentMarkerSelector();
    const key = isProseEntityType(targetKind) ? entityKey(targetKind, targetId) : null;
    return (state: ReturnType<typeof useAgentEditStore.getState>) => select(key ? state.pending[key]?.changes : undefined);
  }, [targetKind, targetId]);
  const agent = useAgentEditStore(selectAgent);
  const markers = useMemo(() => [...comments, ...agent], [comments, agent]);
  const viewport = useMemo(() => scrollEl ? new ScrollMarkerViewportController(scrollEl) : null,
    [scrollEl]);
  useLayoutEffect(() => viewport?.attach(), [viewport]);
  useLayoutEffect(() => {
    viewport?.configure(markers);
    viewport?.setPresentationNeeded(isVisible || isPreparing);
  }, [viewport, markers, isVisible, isPreparing]);
  const ticks = useSyncExternalStore(viewport?.subscribe ?? subscribeEmpty, viewport?.getSnapshot ?? emptySnapshot, emptySnapshot);
  // Ticks that just left keep their place while their sand fades out; a
  // different document starts clean.
  const target = `${targetKind}:${targetId}`;
  const [shown, setShown] = useState({ target, ticks, leaving: NO_TICKS });
  if (shown.target !== target) {
    setShown({ target, ticks, leaving: NO_TICKS });
  } else if (shown.ticks !== ticks) {
    const keys = new Set(ticks.map(tick => tick.key));
    const gone = shown.ticks.filter(tick => !keys.has(tick.key));
    setShown({ target, ticks, leaving: [...shown.leaving.filter(tick => !keys.has(tick.key)), ...gone] });
  }
  useEffect(() => {
    if (!shown.leaving.length) return undefined;
    const timer = window.setTimeout(() => setShown(current => ({ ...current, leaving: NO_TICKS })), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [shown.leaving]);

  const jump = (tick: ScrollMarkerTick) => {
    if (!scrollEl) return;
    const blocks = tick.blockIds.map(id => scrollEl.querySelector<HTMLElement>(scrollMarkerBlockSelector(id)))
      .filter((element): element is HTMLElement => element !== null);
    if (!blocks.length) return;
    blocks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // On the desktop a comment's anchor is drawn again in sand instead of flashing its blocks.
    if (tick.key.startsWith('c:') && !getPlatformRuntime().isMobileShell) selectCommentHighlight(tick.key.slice(2));
    else blocks.forEach(flashBlock);
  };
  if (!ticks.length && !shown.leaving.length) return null;
  // A leaving tick no longer takes the pointer (.is-leaving).
  const renderTick = (tick: ScrollMarkerTick, leaving: boolean) => {
    const seal = scrollMarkerSeal(tick.key);
    return (
      <button key={tick.key} type="button" tabIndex={-1}
        className={`editor__scrollmap-tick ${tick.cls} ${tick.laneCls} editor__scrollmap-tick--seal-${seal.shape}${leaving ? ' is-leaving' : ''}`}
        style={{ top: `${(tick.frac * 100).toFixed(3)}%`, '--seal-turn': `${seal.turn}deg` } as CSSProperties}
        title={t(tick.titleKey)} onClick={() => jump(tick)} />
    );
  };
  return (
    <div className="editor__scrollmap" aria-hidden="true">
      {ticks.map(tick => renderTick(tick, false))}
      {shown.leaving.map(tick => renderTick(tick, true))}
    </div>
  );
}
