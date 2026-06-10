/**
 * /goal 一键演化 — the one call both the dev-harness and the UI go through.
 * Wires the read-only critic ctx + the two leaves + the semantic classifier, then
 * runs the orchestrator. base-field change ⇒ whole-book (effectiveFromOrder -∞);
 * a patch-origin variant would pass the patch's source order instead.
 */
import { runEvolve, type EvolveOpts } from './orchestrator';
import { critiqueChapter } from './evolve-critic';
import { runScopedAgentTurn } from './run-scoped-agent-turn';
import { runShadowEditTurn } from './run-shadow-edit-turn';
import { classifyChange } from './classify-change';
import { setAgentEditModeOverride } from '../agent/agent-edit-mode';
import { useSettingsStore } from '../../store/settings-store';
import { getActiveAgentToolContext, type AgentToolContext } from '../agent/tool-handlers';
import type { ElementChange, EvolveLeaves, EvolveResult } from './types';

export async function evolveElement(
  projectId: string,
  change: ElementChange,
  opts: { effectiveFromOrder?: number; includeDrafts?: boolean } & EvolveOpts = {},
): Promise<EvolveResult> {
  const settings = useSettingsStore.getState();
  const shadowFc = settings.evolveEditorEngine === 'shadow-fc';
  // The Shadow-FC editor runs runAgentTool('edit_block', …) in-renderer → it needs the
  // REAL `write` usecases (else writeEntityProse throws "updateContentByNodeId of
  // undefined" and every edit fails). Borrow them from the mounted bridge; keep this
  // run's projectId. The critic ignores `write` (read-only), and the Agent-SDK editor
  // writes through the IPC bridge's own ctx, so both tolerate a missing bridge.
  const ctx = { projectId, write: getActiveAgentToolContext()?.write } as AgentToolContext;
  const leaves: EvolveLeaves = {
    critique: (chapterId, title, ch, signal, onTrace) => critiqueChapter(ctx, chapterId, title, ch, signal, onTrace),
    edit: shadowFc
      ? (chapterId, title, ch, spots, signal, onTrace) => runShadowEditTurn(ctx, chapterId, title, ch, spots, signal, onTrace)
      : (chapterId, title, ch, spots, signal, onTrace) => runScopedAgentTurn(chapterId, title, ch, spots, signal, onTrace),
  };
  const { effectiveFromOrder = Number.NEGATIVE_INFINITY, includeDrafts = false, ...rest } = opts;
  // Evolve is a Shadow-module op → its edits record with shadowEditMode (default
  // 'approve'), NOT the general agent's agentEditMode. Scoped to this run.
  setAgentEditModeOverride(settings.shadowEditMode);
  try {
    return await runEvolve(
      { projectId, change, effectiveFromOrder, includeDrafts },
      leaves,
      {
        classify: () => classifyChange(projectId, change),
        // Shadow-FC edits are independent per chapter → fan out; the Agent-SDK editor
        // shares ONE main-process agent → must stay serial (1).
        editConcurrency: shadowFc ? 3 : 1,
        ...rest,
      },
    );
  } finally {
    setAgentEditModeOverride(null);
  }
}
