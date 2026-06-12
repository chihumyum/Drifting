/**
 * Whole-turn revert — restores the manuscript to its state before a given
 * agent turn ran, by applying the INVERSE of every change in that turn's
 * checkpoint and every later one (newest first, so per-turn diffs compose
 * back to the snapshot).
 *
 * Reuses the per-change machinery the review surfaces already trust:
 *   - prose blocks  → revertEntityBlock (Yjs, non-agent origin, persists+syncs)
 *   - summary/kv/…  → the same usecase write-backs useFieldReview.reject does,
 *                     via the live AgentToolContext published by the bridge
 * Each reverted change is also queued as a RevertRecord so the agent's next
 * turn is told its edits were undone (same contract as a per-block ✗), and the
 * matching pending review markers / activity dots are cleared.
 *
 * Changes we cannot structurally undo (today: 'patch' card creations — they
 * have their own keep/discard review) are skipped and reported.
 */
import loglevel from 'loglevel';
import { useAgentCheckpointStore, type TurnCheckpoint } from '../../store/agent-checkpoint-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useDataStore } from '../../store/data-store';
import type { ActivityEntityType } from './tool-entity-ref';
import type { AgentBlockChange } from './block-diff';
import { applyKvRevert, isFieldChange } from './field-diff';
import { revertEntityBlock } from './chapter-prose';
import { getActiveAgentToolContext, type AgentToolContext } from './tool-handlers';

const log = loglevel.getLogger('turn-revert');
log.setLevel(loglevel.levels.WARN);

export interface TurnRevertResult {
  /** Checkpoints (turns) rolled back. */
  turns: number;
  /** Prose blocks restored/removed/re-inserted. */
  blocks: number;
  /** Structured fields written back. */
  fields: number;
  /** Human-readable notes for changes that could not be undone. */
  skipped: string[];
}

async function revertFieldChange(
  ctx: AgentToolContext,
  entityType: ActivityEntityType,
  id: string,
  c: AgentBlockChange & { field: NonNullable<AgentBlockChange['field']> },
): Promise<'ok' | 'skip'> {
  const s = useDataStore.getState();
  switch (c.field.kind) {
    case 'summary':
      if (entityType === 'node') await ctx.write.updateNode(id, { summary: c.oldText });
      else if (entityType === 'element') await ctx.write.updateElement(id, { summary: c.oldText });
      else if (entityType === 'storyline') await ctx.write.updateStoryline({ id, summary: c.oldText });
      else return 'skip';
      return 'ok';
    case 'kv': {
      if (entityType === 'element') {
        const cur = s.bookElements.find((e) => e.id === id)?.kvJson ?? '[]';
        await ctx.write.updateElement(id, { kvJson: applyKvRevert(cur, c) });
        return 'ok';
      }
      if (entityType === 'storyline') {
        const cur = s.storylines.find((sl) => sl.id === id)?.kvJson ?? '[]';
        await ctx.write.updateStoryline({ id, kvJson: applyKvRevert(cur, c) });
        return 'ok';
      }
      return 'skip';
    }
    case 'templatekv': {
      if (entityType !== 'category') return 'skip';
      const cur = s.bookElementCategories.find((cat) => cat.id === id)?.elementTemplateKvJson ?? '[]';
      await ctx.write.updateCategory(id, { elementTemplateKvJson: applyKvRevert(cur, c) });
      return 'ok';
    }
    case 'group':
      if (entityType !== 'element') return 'skip';
      await ctx.write.updateElement(id, { groupName: c.oldText });
      return 'ok';
    default:
      // 'patch' (and anything future): no structural inverse here — the patch
      // card's own keep/discard review covers it.
      return 'skip';
  }
}

async function revertCheckpoint(cp: TurnCheckpoint, result: TurnRevertResult): Promise<void> {
  const ctx = getActiveAgentToolContext();
  const edits = useAgentEditStore.getState();
  const activity = useAgentActivityStore.getState();

  for (const { entityType, id, changes } of Object.values(cp.entities)) {
    const fields = changes.filter(isFieldChange);
    const prose = changes.filter((c) => !c.field);
    // Inverse order matters within a turn: restore changed text and re-insert
    // deleted blocks while every anchor still exists, THEN remove new blocks.
    // Deletions are re-inserted in REVERSE document order: consecutive deleted
    // blocks share one surviving anchor, and inserting directly after it means
    // the last-inserted ends up first — reversing restores the original order.
    const ordered = [
      ...prose.filter((c) => c.op === 'changed'),
      ...prose.filter((c) => c.op === 'deleted').reverse(),
      ...prose.filter((c) => c.op === 'new'),
    ];

    for (const c of ordered) {
      try {
        await revertEntityBlock(entityType, id, c);
        result.blocks += 1;
        edits.resolveBlocks(entityType, id, [c.blockId]);
        edits.recordRevert(cp.projectId, entityType, id, c);
      } catch (err) {
        log.error('turn revert: block revert failed', entityType, id, c.blockId, err);
        result.skipped.push(`${entityType} ${id} 的一个段落未能还原`);
      }
    }

    for (const c of fields) {
      try {
        if (!ctx) {
          result.skipped.push(`字段「${c.field.label}」未能还原（无可用写入上下文）`);
          continue;
        }
        const r = await revertFieldChange(ctx, entityType, id, c);
        if (r === 'ok') {
          result.fields += 1;
          edits.resolveBlocks(entityType, id, [c.blockId]);
          edits.recordRevert(cp.projectId, entityType, id, c);
        } else {
          result.skipped.push(`字段「${c.field.label}」不支持自动还原`);
        }
      } catch (err) {
        log.error('turn revert: field revert failed', entityType, id, c.blockId, err);
        result.skipped.push(`字段「${c.field.label}」未能还原`);
      }
    }

    activity.clearTouched(entityType, id);
  }
}

/**
 * Roll the project back to the snapshot taken before `turnId` ran: reverts that
 * turn's checkpoint and every later checkpoint of the same project, newest
 * first, then drops them from the store.
 */
export async function revertToTurn(projectId: string, turnId: string): Promise<TurnRevertResult> {
  const all = useAgentCheckpointStore
    .getState()
    .checkpoints.filter((c) => c.projectId === projectId);
  const idx = all.findIndex((c) => c.turnId === turnId);
  if (idx < 0) throw new Error('checkpoint not found');
  const toRevert = all.slice(idx).reverse(); // newest first

  const result: TurnRevertResult = { turns: 0, blocks: 0, fields: 0, skipped: [] };
  for (const cp of toRevert) {
    await revertCheckpoint(cp, result);
    result.turns += 1;
    // Drop as we go, so a failure midway leaves only the un-reverted prefix.
    useAgentCheckpointStore.getState().removeCheckpoints([cp.turnId]);
  }
  return result;
}
