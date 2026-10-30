/**
 * Shows what an edit made in another editor changed (docs/markdown-mirror.md)
 * through the Agent's unread presentation, in blue: the sidebar marker, the
 * reveal, the words that stay coloured and the scrollbar ticks.
 *
 * An editor that autosaves every second or two merges the same paragraph
 * again and again. A paragraph whose reveal the author just watched is not
 * animated again for a while: its new words join the blue ones already shown.
 */
import { useAgentEditStore } from '../store/agent-edit-store';
import { getPlatformRuntime } from '../platform/runtime';
import type { AgentBlockChange } from './agent/block-diff';
import { entityKey, type ActivityEntityType } from './agent/tool-entity-ref';
import { recordAgentRecentChange } from './agent-recent-changes';

/** How long after a reveal another merge of the paragraph only recolours it. */
export const EXTERNAL_REPLAY_QUIET_MS = 15_000;

/** Per paragraph: when it last showed, and its text before the first reveal. */
const shown = new Map<string, { at: number; oldText: string }>();

const keyOf = (entityType: ActivityEntityType, id: string, blockId: string) =>
  `${entityKey(entityType, id)}:${blockId}`;

/** The reveal of an external change finished (AgentEditAnimator). */
export function noteExternalRevealed(
  entityType: ActivityEntityType,
  id: string,
  change: Pick<AgentBlockChange, 'blockId' | 'oldText'>,
  now = Date.now(),
): void {
  const key = keyOf(entityType, id, change.blockId);
  const previous = shown.get(key);
  const recent = previous && now - previous.at < EXTERNAL_REPLAY_QUIET_MS;
  shown.set(key, { at: now, oldText: recent ? previous.oldText : change.oldText });
}

export interface ExternalEditPlan {
  /** Played like an Agent change, in blue. */
  reveal: AgentBlockChange[];
  /** Shown a moment ago: coloured without another reveal. */
  recolor: AgentBlockChange[];
}

export function planExternalEdits(
  entityType: ActivityEntityType,
  id: string,
  changes: readonly AgentBlockChange[],
  now = Date.now(),
): ExternalEditPlan {
  const plan: ExternalEditPlan = { reveal: [], recolor: [] };
  for (const change of changes) {
    if (change.field) continue;
    const previous = shown.get(keyOf(entityType, id, change.blockId));
    const recent = previous && now - previous.at < EXTERNAL_REPLAY_QUIET_MS;
    if (recent && change.op === 'changed') {
      // Colour every word added since the first reveal, not just this save's.
      plan.recolor.push({ ...change, oldText: previous.oldText, source: 'file' });
    } else {
      plan.reveal.push({ ...change, source: 'file' });
    }
  }
  return plan;
}

/** Block ids an open editor must mask until their reveal plays. */
export function externalRevealMask(plan: ExternalEditPlan): string[] {
  return plan.reveal.filter((change) => change.op !== 'deleted').map((change) => change.blockId);
}

export function presentExternalEdits(entityType: ActivityEntityType, id: string, plan: ExternalEditPlan, now = Date.now()): void {
  if (plan.reveal.length > 0) useAgentEditStore.getState().recordExternal(entityType, id, plan.reveal);
  for (const change of plan.recolor) {
    noteExternalRevealed(entityType, id, change, now);
    if (!getPlatformRuntime().isMobileShell) recordAgentRecentChange(entityType, id, change);
  }
}

/** Test seam: forget which paragraphs were shown. */
export function resetExternalEditPresentation(): void {
  shown.clear();
}
