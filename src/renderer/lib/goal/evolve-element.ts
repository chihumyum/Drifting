/**
 * /goal 一键演化 — the one call both the dev-harness and the UI go through.
 * Wires the read-only critic ctx + the two leaves + the semantic classifier, then
 * runs the orchestrator. base-field change ⇒ whole-book (effectiveFromOrder -∞);
 * a patch-origin variant would pass the patch's source order instead.
 */
import { runEvolve, type EvolveOpts } from './orchestrator';
import { critiqueChapter } from './evolve-critic';
import { runScopedAgentTurn } from './run-scoped-agent-turn';
import { classifyChange } from './classify-change';
import type { AgentToolContext } from '../agent/tool-handlers';
import type { ElementChange, EvolveLeaves, EvolveResult } from './types';

export async function evolveElement(
  projectId: string,
  change: ElementChange,
  opts: { effectiveFromOrder?: number } & EvolveOpts = {},
): Promise<EvolveResult> {
  // ctx.write is unused: the critic is read-only; the editor leaf writes through the
  // agent IPC bridge, not this ctx.
  const ctx = { projectId } as AgentToolContext;
  const leaves: EvolveLeaves = {
    critique: (chapterId, title, ch) => critiqueChapter(ctx, chapterId, title, ch),
    edit: (chapterId, title, ch, spots) => runScopedAgentTurn(chapterId, title, ch, spots),
  };
  const { effectiveFromOrder = Number.NEGATIVE_INFINITY, ...rest } = opts;
  return runEvolve(
    { projectId, change, effectiveFromOrder },
    leaves,
    { classify: () => classifyChange(projectId, change), ...rest },
  );
}
