/** Presentation of committed structured-field changes. Acknowledging only
 * clears unread state; the write and its settlement receipt already committed. */
import { useCallback, useMemo } from 'react';
import { useAgentEditStore } from '../store/agent-edit-store';
import { useAgentActivityStore } from '../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import type { AgentBlockChange } from '../lib/agent/block-diff';
import { isFieldChange } from '../lib/agent/field-diff';

export function useFieldReview(entityType: ActivityEntityType, id: string | null | undefined) {
  const entry = useAgentEditStore((s) => (id ? s.pending[entityKey(entityType, id)] : undefined));
  const fieldChanges = useMemo(() => (entry?.changes ?? []).filter(isFieldChange), [entry]);
  const summaryChange = useMemo(() => fieldChanges.find((c) => c.field.kind === 'summary') ?? null, [fieldChanges]);
  const kvChanges = useMemo(() => fieldChanges.filter((c) => c.field.kind === 'kv'), [fieldChanges]);
  const templateKvChanges = useMemo(() => fieldChanges.filter((c) => c.field.kind === 'templatekv'), [fieldChanges]);
  const accept = useCallback((change: AgentBlockChange) => {
    if (!id) return;
    const store = useAgentEditStore.getState();
    if (change.reviewId) store.resolveReviews([change.reviewId]);
    store.resolveBlocks(entityType, id, [change.blockId]);
    useAgentActivityStore.getState().markSpotSeen(entityType, id,
      change.field?.kind === 'summary' ? { summary: true } : { structural: true });
  }, [entityType, id]);
  return { summaryChange, kvChanges, templateKvChanges, hasAny: fieldChanges.length > 0, accept };
}
