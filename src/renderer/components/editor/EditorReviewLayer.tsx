import { useEffect } from 'react';

import { AgentEditAnimator } from './AgentEditAnimator';
import { EditorScrollMarkers } from './EditorScrollMarkers';
import { planAgentAddedProseReveal } from './agent-added-file';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';

interface EditorReviewLayerProps {
  projectId: string;
  entityType: ActivityEntityType;
  id: string | null | undefined;
  scrollEl: HTMLElement | null;
  /** Whether the comment rail is open — comment scroll ticks are hidden when
   *  it's closed (agent-change ticks always show). Defaults to true. */
  commentsVisible?: boolean;
}

const ADDED_FILE_EMPTY_GRACE_MS = 4_500;

function topLevelProseBlocks(scrollEl: HTMLElement) {
  const prose = scrollEl.querySelector<HTMLElement>('.ProseMirror');
  if (!prose) return null;
  return Array.from(prose.children).flatMap((node) => {
    const blockId = node.getAttribute('data-block-id');
    return blockId ? [{ blockId, text: node.textContent ?? '' }] : [];
  });
}

/**
 * A newly created workspace file has no before-snapshot and therefore no
 * ordinary block review projection. Wait until ProseMirror assigns stable ids,
 * then seed every textual top-level block as an auto-mode `new` change. The
 * normal AgentEditAnimator owns visibility, typing, and interruption recovery.
 */
function useAgentAddedFileReveal(
  scrollEl: HTMLElement | null,
  entityType: ActivityEntityType,
  id: string | null | undefined,
) {
  const key = id ? entityKey(entityType, id) : null;
  const addition = useAgentEditStore((state) => (key ? state.additions[key] : undefined));
  const pending = useAgentEditStore((state) => (key ? state.pending[key] : undefined));

  useEffect(() => {
    if (!scrollEl || !id || !addition || addition.revealBlockIds !== null) {
      return undefined;
    }

    const seed = () => {
      const blocks = topLevelProseBlocks(scrollEl);
      if (!blocks) return false;
      const changes = planAgentAddedProseReveal(blocks);
      if (changes.length === 0) return false;
      useAgentEditStore.getState().beginAdditionReveal(entityType, id, changes);
      return true;
    };

    if (seed()) return undefined;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (seed()) observer.disconnect();
      });
    });
    observer.observe(scrollEl, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => {
      // An intentionally empty file has no text to animate. Mark its first open
      // complete only after the editor had a full hydration grace period.
      if (topLevelProseBlocks(scrollEl)) {
        useAgentEditStore.getState().beginAdditionReveal(entityType, id, []);
      }
    }, ADDED_FILE_EMPTY_GRACE_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [addition, entityType, id, scrollEl]);

  useEffect(() => {
    if (!id || !addition || addition.revealBlockIds === null) return;
    const outstanding = new Set(pending?.changes.map((change) => change.blockId) ?? []);
    if (addition.revealBlockIds.some((blockId) => outstanding.has(blockId))) return;
    useAgentEditStore.getState().resolveAddition(entityType, id);
    useAgentActivityStore.getState().markSpotSeen(entityType, id, { structural: true });
  }, [addition, entityType, id, pending]);
}

/**
 * The agent-edit review surface for ONE prose editor, as a single mountable
 * unit: the colored scrollbar ticks (overview ruler) + the reveal / approve
 * overlay (✓/✗ in approve mode, typewriter reveal in auto mode). Mounted once
 * per prose editor — chapter / element / storyline / category — so the review
 * wiring is identical everywhere and future review pieces are added in one file.
 *
 * Mount it as a sibling of `.editor-scroll`, inside the positioned `.editor-body`
 * (both children position absolutely against `.editor-body`). The companion hook
 * `useAgentChangeMarks(scrollEl, entityType, id)` must still be called at the top
 * level of the view/scaffold (a hook can't live inside this component).
 */
export function EditorReviewLayer({
  projectId,
  entityType,
  id,
  scrollEl,
  commentsVisible = true,
}: EditorReviewLayerProps) {
  useAgentAddedFileReveal(scrollEl, entityType, id);

  return (
    <>
      <EditorScrollMarkers
        projectId={projectId}
        targetKind={entityType}
        targetId={id ?? ''}
        scrollEl={scrollEl}
        commentsVisible={commentsVisible}
      />
      <AgentEditAnimator
        scrollEl={scrollEl}
        projectId={projectId}
        entityType={entityType}
        id={id}
      />
    </>
  );
}
