/**
 * Wiring for the in-page review of an entity's agent-edited NON-PROSE fields
 * (summary / kv / template kv). Reads the pending field changes for one entity
 * from the edit store and returns them split by family, plus accept/reject
 * handlers:
 *   - accept: drop the change (value already applied) + clear the activity dot.
 *   - reject: write the OLD value back through the caller's usecase, then drop
 *     the change AND queue a revert so the agent learns its edit was undone
 *     (it ran bypassPermissions and otherwise believes it stuck) — exactly the
 *     prose reject contract, see agent-edit-store.recordRevert.
 *
 * The store + diff are field-agnostic; only the write-back is entity-specific,
 * so the caller supplies thin `writers` bound to its own usecases.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useAgentEditStore } from '../store/agent-edit-store';
import { useAgentActivityStore } from '../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import type { AgentBlockChange } from '../lib/agent/block-diff';
import { applyKvRevert, isFieldChange } from '../lib/agent/field-diff';
import {
  acceptDriftingAgentWriteReview,
  rejectDriftingAgentWriteReview,
} from '../lib/agent/useDriftingAgentRuntime';
import {
  approveDurableAgentReviewsForEntity,
  rejectDurableAgentReviewsForEntity,
} from '../lib/agent/durable-review-actions';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useFieldReview');
log.setLevel(loglevel.levels.WARN);

export interface FieldReviewWriters {
  summary?: (value: string) => void | Promise<void>;
  kvJson?: (value: string) => void | Promise<void>;
  templateKvJson?: (value: string) => void | Promise<void>;
}

export interface FieldReviewValues {
  /** Current (post-edit) kv blob — the base a kv revert is reconstructed from. */
  kvJson?: string;
  templateKvJson?: string;
}

export interface EntityFieldReview {
  summaryChange: AgentBlockChange | null;
  kvChanges: AgentBlockChange[];
  templateKvChanges: AgentBlockChange[];
  hasAny: boolean;
  accept: (change: AgentBlockChange) => void;
  reject: (change: AgentBlockChange) => void;
}

export function useFieldReview(
  entityType: ActivityEntityType,
  id: string | null | undefined,
  projectId: string,
  values: FieldReviewValues,
  writers: FieldReviewWriters,
): EntityFieldReview {
  const settling = useRef(new Set<string>());
  const entry = useAgentEditStore((s) => (id ? s.pending[entityKey(entityType, id)] : undefined));
  const fieldChanges = useMemo(() => (entry?.changes ?? []).filter(isFieldChange), [entry]);
  const summaryChange = useMemo(
    () => fieldChanges.find((c) => c.field.kind === 'summary') ?? null,
    [fieldChanges],
  );
  const kvChanges = useMemo(
    () => fieldChanges.filter((c) => c.field.kind === 'kv'),
    [fieldChanges],
  );
  const templateKvChanges = useMemo(
    () => fieldChanges.filter((c) => c.field.kind === 'templatekv'),
    [fieldChanges],
  );

  const { summary: writeSummary, kvJson: writeKvJson, templateKvJson: writeTemplateKvJson } =
    writers;
  const { kvJson: curKvJson, templateKvJson: curTemplateKvJson } = values;

  const accept = useCallback(
    (c: AgentBlockChange) => {
      if (!id) return;
      if (c.reviewId) {
        const settlementKey = `${entityType}:${id}:${c.blockId}:accept`;
        if (settling.current.has(settlementKey)) return;
        settling.current.add(settlementKey);
        const store = useAgentEditStore.getState();
        void approveDurableAgentReviewsForEntity({
          entityType,
          id,
          batches: store,
          acceptReview: acceptDriftingAgentWriteReview,
          matchesBatch: (batch) =>
            batch.changes.some(
              (change) => change.blockId === c.blockId,
            ),
          onAllAccepted(reviewIds, batches) {
            const current = useAgentEditStore.getState();
            current.resolveReviews([...reviewIds]);
            for (const batch of batches) {
              for (const change of batch.changes) {
                const spot =
                  change.field?.kind === 'summary'
                    ? ({ summary: true } as const)
                    : ({ structural: true } as const);
                useAgentActivityStore
                  .getState()
                  .markSpotSeen(
                    batch.entityType,
                    batch.id,
                    spot,
                  );
              }
            }
          },
        })
          .catch((error) => {
            log.error(
              'durable field accept failed, keeping review pending',
              error,
            );
          })
          .finally(() => {
            settling.current.delete(settlementKey);
          });
        return;
      }
      useAgentEditStore.getState().resolveBlocks(entityType, id, [c.blockId]);
      // Clear the matching activity dot spot (summary tools mark a summary spot;
      // kv/group writes mark a structural one). No-op if no dot is pending.
      const spot = c.field?.kind === 'summary' ? ({ summary: true } as const) : ({ structural: true } as const);
      useAgentActivityStore.getState().markSpotSeen(entityType, id, spot);
    },
    [entityType, id],
  );

  const reject = useCallback(
    (c: AgentBlockChange) => {
      const field = c.field;
      if (!id || !field) return;
      if (c.reviewId) {
        const settlementKey = `${entityType}:${id}:${c.blockId}:reject`;
        if (settling.current.has(settlementKey)) return;
        settling.current.add(settlementKey);
        const store = useAgentEditStore.getState();
        void rejectDurableAgentReviewsForEntity({
          entityType,
          id,
          batches: store,
          rejectReview: rejectDriftingAgentWriteReview,
          decisionNote: 'Rejected from field review',
          matchesBatch: (batch) =>
            batch.changes.some(
              (change) => change.blockId === c.blockId,
            ),
          onAllReverted(reviewIds, batches) {
            const current = useAgentEditStore.getState();
            for (const batch of batches) {
              for (const change of batch.changes) {
                current.recordRevert(
                  projectId,
                  batch.entityType,
                  batch.id,
                  change,
                );
                const spot =
                  change.field?.kind === 'summary'
                    ? ({ summary: true } as const)
                    : ({ structural: true } as const);
                useAgentActivityStore
                  .getState()
                  .markSpotSeen(
                    batch.entityType,
                    batch.id,
                    spot,
                  );
              }
            }
            current.resolveReviews([...reviewIds]);
          },
        })
          .catch((error) => {
            log.error(
              'durable field reject failed, keeping review pending',
              error,
            );
          })
          .finally(() => {
            settling.current.delete(settlementKey);
          });
        return;
      }
      const apply = async (): Promise<void> => {
        switch (field.kind) {
          case 'summary':
            await writeSummary?.(c.oldText);
            break;
          case 'kv':
            await writeKvJson?.(applyKvRevert(curKvJson ?? '[]', c));
            break;
          case 'templatekv':
            await writeTemplateKvJson?.(applyKvRevert(curTemplateKvJson ?? '[]', c));
            break;
          default:
            break;
        }
      };
      // Only clear the marker once the write-back actually applied — otherwise the
      // field would look reverted while the agent's value secretly remains.
      void Promise.resolve(apply())
        .then(() => {
          useAgentEditStore.getState().resolveBlocks(entityType, id, [c.blockId]);
          useAgentEditStore.getState().recordRevert(projectId, entityType, id, c);
        })
        .catch((err) => {
          log.error('field reject: write-back failed, keeping change pending', err);
        });
    },
    [entityType, id, projectId, writeSummary, writeKvJson, writeTemplateKvJson, curKvJson, curTemplateKvJson],
  );

  return {
    summaryChange,
    kvChanges,
    templateKvChanges,
    hasAny: fieldChanges.length > 0,
    accept,
    reject,
  };
}
