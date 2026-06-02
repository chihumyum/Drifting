import { AgentEditAnimator } from './AgentEditAnimator';
import { EditorScrollMarkers } from './EditorScrollMarkers';
import type { ActivityEntityType } from '../../lib/agent/tool-entity-ref';

interface EditorReviewLayerProps {
  projectId: string;
  entityType: ActivityEntityType;
  id: string | null | undefined;
  scrollEl: HTMLElement | null;
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
export function EditorReviewLayer({ projectId, entityType, id, scrollEl }: EditorReviewLayerProps) {
  return (
    <>
      <EditorScrollMarkers
        projectId={projectId}
        targetKind={entityType}
        targetId={id ?? ''}
        scrollEl={scrollEl}
      />
      <AgentEditAnimator scrollEl={scrollEl} projectId={projectId} entityType={entityType} id={id} />
    </>
  );
}
