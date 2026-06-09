/**
 * /goal 一键演化 — shared types (shadow/GOAL-EVOLVE.md).
 *
 * The orchestrator is a deterministic renderer-side loop with two model leaves:
 * an element-scoped CRITIC (does the prose still contradict the element's NEW
 * setting?) and an EDITOR (resolve those contradictions). Both are injected so
 * the loop can be smoked with stubs.
 */
import type { AgentBlockChange } from '../agent/block-diff';

/** A single element-setting change to propagate into the prose. */
export interface ElementChange {
  elementId: string;
  elementName: string;
  /** Human label of what moved, e.g. "简介" / "视力". Surfaced in prompts. */
  field?: string;
  /** Old value (human-readable). Empty ⇒ no explicit baseline to contrast. */
  oldSetting: string;
  /** New value the prose must conform to. */
  newSetting: string;
  /** The element's FULL current content rendered as text (name/aliases/summary/
   *  facts/body), pre-loaded once and injected into the editor fan-out so the
   *  agent doesn't read_element per chapter. See element-profile.ts. */
  profile?: string;
}

/** One contradiction the critic found between the prose and the NEW setting. */
export interface ContradictionSpot {
  chapterId: string;
  chapterTitle: string;
  /** Offending blocks; [] = chapter-level. */
  blockIds: string[];
  reason: string;
  confidence: number;
}

/**
 * Location-stable identity for strict-shrink set tracking across rounds. Keyed on
 * WHERE (chapter + blocks), NOT the free-text reason — so resolving a spot drops
 * its key, and a spot re-firing at the same blocks keeps the same key (no false
 * "new" churn). Chapter-level spots collapse to one key per chapter.
 */
export function spotKey(s: ContradictionSpot): string {
  const where = s.blockIds.length ? [...s.blockIds].sort().join(',') : 'chapter';
  return `${s.chapterId}:${where}`;
}

export interface ScopedChapter {
  chapterId: string;
  title: string;
  order: number;
}

/** A chapter where the element appears, with the block locations of its mentions.
 *  The navigable worklist handed to the author for an 'essence' change — LOCATE
 *  every scene, don't auto-edit. This is the FULL appearance set (honest), not a
 *  (misleadingly short) contradiction list. */
export interface ElementAppearance extends ScopedChapter {
  blockIds: string[];
}

/** What the editor leaf reports after one scoped edit turn. */
export interface EditTurnResult {
  chapterId: string;
  ok: boolean;
  editedBlockIds: string[];
  error?: string;
}

/** A per-chapter failure that was ISOLATED (logged, batch continued) rather than
 *  aborting the whole run. An errored chapter is "not reliably assessed". */
export interface EvolveError {
  chapterId: string;
  phase: 'detect' | 'edit' | 'verify';
  error: string;
}

/** Injected leaves — lets the orchestrator run with stubs for smoke tests. */
export interface EvolveLeaves {
  critique: (chapterId: string, title: string, change: ElementChange) => Promise<ContradictionSpot[]>;
  edit: (
    chapterId: string,
    title: string,
    change: ElementChange,
    spots: ContradictionSpot[],
  ) => Promise<EditTurnResult>;
}

export type EvolveStopReason =
  | 'converged'
  | 'max-rounds'
  | 'stalled'
  | 'no-scope'
  | 'dry-run'
  /** Round-0 blast radius exceeded the confirm threshold — stopped BEFORE editing,
   *  residual = the full preview, awaiting the author's go-ahead (force). */
  | 'needs-confirmation'
  /** The change is a fundamental essence/nature rewrite (of a character, place,
   *  rule, …) — the critic's blind spot (contradiction-anchored → under-detects).
   *  Declined before scoping; the loop would give a false "done". Force overrides. */
  | 'out-of-scope';

/** Semantic class of the change — decides whether the evolve loop is the right
 *  tool. Element-agnostic (character / place / object / faction / rule …):
 *  factual ⇒ a discrete, prose-falsifiable change → hard contradictions the loop
 *  resolves cleanly; essence ⇒ a change to the thing's fundamental nature/feel →
 *  needs scene reconception, diffuse, mostly invisible to the critic. */
export interface ChangeClass {
  kind: 'factual' | 'essence' | 'mixed';
  reason: string;
  /** mixed only: the discrete/falsifiable sub-change the loop should target. */
  factualPart?: string;
  /** mixed (or essence) only: the diffuse sub-change handed to the human. */
  essencePart?: string;
}

export interface EvolveResult {
  scoped: ScopedChapter[];
  rounds: number;
  stopReason: EvolveStopReason;
  /** Initial contradictions that are no longer open. */
  resolvedCount: number;
  /** Still-open contradictions handed to the human. */
  residual: ContradictionSpot[];
  edits: EditTurnResult[];
  /** Pending (staged, not-yet-approved) edits per touched chapter — the batch the
   *  human reviews. Harvested from the agent-edit-store at loop end. */
  pendingByChapter: Record<string, AgentBlockChange[]>;
  /** Per-chapter failures that were isolated (batch kept going). Non-empty ⇒ those
   *  chapters weren't reliably assessed/edited — surface, don't treat as "done". */
  errors: EvolveError[];
  /** For an 'essence' out-of-scope stop: the element's FULL appearance set (chapters
   *  + mention blocks) as a manual reconception worklist. NOT a contradiction list. */
  worklist?: ElementAppearance[];
  /** Human-facing note for a gated stop (out-of-scope reason / confirm prompt). */
  note?: string;
}
