import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { getAgentRecentMarks, subscribeAgentRecentMarks } from '../../lib/agent-recent-changes';
import { AgentRecentHighlightPainter } from '../../lib/agent-recent-highlight';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { getPlatformRuntime } from '../../platform/runtime';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';

interface AgentRecentChangeHighlightsProps {
  scrollEl: HTMLElement | null;
  entityType: ActivityEntityType;
  /** `null` paints every document of the kind (the whole-book reader). */
  targetId: string | null;
}

/** Keeps the words the Agent just wrote coloured on the desktop (added green,
 * rewritten purple) until the author's pointer rests on them. Painting never
 * mutates the prose DOM; hidden surfaces release their ranges. */
export function AgentRecentChangeHighlights({ scrollEl, entityType, targetId }: AgentRecentChangeHighlightsProps) {
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const marks = useSyncExternalStore(subscribeAgentRecentMarks, getAgentRecentMarks, getAgentRecentMarks);
  const painter = useMemo(() => {
    if (!scrollEl || getPlatformRuntime().isMobileShell) return null;
    const entity = targetId === null ? null : entityKey(entityType, targetId);
    return new AgentRecentHighlightPainter(scrollEl,
      (mark) => mark.entityType === entityType && (entity === null || mark.entity === entity));
  }, [scrollEl, entityType, targetId]);
  const presented = isVisible || isPreparing;
  useLayoutEffect(() => (presented ? painter?.attach() : undefined), [painter, presented]);
  useLayoutEffect(() => painter?.update(marks), [painter, marks]);
  return null;
}
