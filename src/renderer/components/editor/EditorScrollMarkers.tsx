import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommentTargetKind } from '../../domain/comment';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { flashBlock } from '../../lib/scroll-to-block';
import { isProseEntityType } from '../../lib/yjs-doc-id';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';
import { createAgentMarkerSelector, createCommentMarkerSelector, EMPTY_SCROLL_MARKERS, scrollMarkerBlockSelector } from './scroll-marker-model';
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

/** Clickable overview ticks overlay the native scrollbar outside .editor-scroll.
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

  const jump = (blockIds: readonly string[]) => {
    if (!scrollEl) return;
    const blocks = blockIds.map(id => scrollEl.querySelector<HTMLElement>(scrollMarkerBlockSelector(id)))
      .filter((element): element is HTMLElement => element !== null);
    if (!blocks.length) return;
    blocks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    blocks.forEach(flashBlock);
  };
  if (!ticks.length) return null;
  return (
    <div className="editor__scrollmap" aria-hidden="true">
      {ticks.map(tick => (
        <button key={tick.key} type="button" tabIndex={-1}
          className={`editor__scrollmap-tick ${tick.cls} ${tick.laneCls}`}
          style={{ top: `${(tick.frac * 100).toFixed(3)}%` }}
          title={t(tick.titleKey)} onClick={() => jump(tick.blockIds)} />
      ))}
    </div>
  );
}
