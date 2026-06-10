/**
 * /goal 一键演化 — the EDITOR leaf running on the SHADOW provider (no Anthropic).
 * Sibling of run-scoped-agent-turn (Agent SDK); evolveElement picks one by the
 * `evolveEditorEngine` setting. Both return the same EditTurnResult shape.
 */
import { runShadowEditBatch, type AgentToolContext } from '../agent/tool-handlers';
import { buildEditInstruction } from './edit-prompt';
import type { AgenticTraceStep } from '../ai/shadow-rules';
import type { ElementChange, ContradictionSpot, EditTurnResult } from './types';

export async function runShadowEditTurn(
  ctx: AgentToolContext,
  chapterId: string,
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<EditTurnResult> {
  if (spots.length === 0) return { chapterId, ok: true, editedBlockIds: [] };
  const r = await runShadowEditBatch(ctx, chapterId, buildEditInstruction(chapterTitle, change, spots), signal, onTrace);
  return { chapterId, ok: r.ok, editedBlockIds: r.editedBlockIds, error: r.error };
}
