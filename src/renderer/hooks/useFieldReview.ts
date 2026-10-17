/** Presentation of committed structured-field changes. Completion only clears
 * unread state; durable legacy reviews are settled by the same runtime owner. */
import { useCallback, useMemo, useRef } from 'react';
import { useAgentEditStore } from '../store/agent-edit-store';
import { useAgentActivityStore } from '../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import type { AgentBlockChange } from '../lib/agent/block-diff';
import { isFieldChange } from '../lib/agent/field-diff';
import { acceptDriftingAgentWriteReview } from '../lib/agent/useDriftingAgentRuntime';
import { approveDurableAgentReviewsForEntity } from '../lib/agent/durable-review-actions';

export function useFieldReview(entityType: ActivityEntityType, id: string | null | undefined) {
  const settling = useRef(new Set<string>());
  const entry = useAgentEditStore((s) => (id ? s.pending[entityKey(entityType, id)] : undefined));
  const fieldChanges = useMemo(() => (entry?.changes ?? []).filter(isFieldChange), [entry]);
  const summaryChange = useMemo(() => fieldChanges.find((c) => c.field.kind === 'summary') ?? null, [fieldChanges]);
  const kvChanges = useMemo(() => fieldChanges.filter((c) => c.field.kind === 'kv'), [fieldChanges]);
  const templateKvChanges = useMemo(() => fieldChanges.filter((c) => c.field.kind === 'templatekv'), [fieldChanges]);
  const accept = useCallback((change: AgentBlockChange) => {
    if (!id) return;
    const finish = () => {
      useAgentEditStore.getState().resolveBlocks(entityType, id, [change.blockId]);
      useAgentActivityStore.getState().markSpotSeen(entityType, id,
        change.field?.kind === 'summary' ? { summary: true } : { structural: true });
    };
    if (!change.reviewId) { finish(); return; }
    if (settling.current.has(change.reviewId)) return;
    const reviewId = change.reviewId;
    settling.current.add(reviewId);
    void approveDurableAgentReviewsForEntity({
      entityType, id, batches: useAgentEditStore.getState(),
      acceptReview: acceptDriftingAgentWriteReview,
      matchesBatch: (batch) => batch.changes.some((c) => c.blockId === change.blockId),
      onAllAccepted: (reviewIds) => {
        useAgentEditStore.getState().resolveReviews([...reviewIds]);
        finish();
      },
    }).catch((error) => console.error('[agent] field presentation settlement failed', error))
      .finally(() => settling.current.delete(reviewId));
  }, [entityType, id]);
  return { summaryChange, kvChanges, templateKvChanges, hasAny: fieldChanges.length > 0, accept };
}
