// Shared types for the shadow review engine. No LangGraph / Electron imports —
// framework-agnostic so the graph and its deps can be unit-tested.

// Atomic, individually-checkable assertion compiled from a project rule. `type`
// is INFERRED by the normalizer (the author never picks it): mechanical kinds
// route to deterministic evaluators; 'semantic' routes to the LLM evaluator.
export type ChecklistItemType = 'word-count' | 'must-appear' | 'banned-words' | 'semantic';

export interface ChecklistItem {
  id: string;
  assertion: string;
  type: ChecklistItemType;
  params?: Record<string, unknown>;
}

// A compiled rule as the engine evaluates it — a subset of the renderer's
// ProjectRule, delivered as plain data (main can't import renderer types).
export interface RuleSpec {
  id: string;
  checklist: ChecklistItem[];
}

// The read-only view of a chapter the review graph operates on. Assembled from
// the LOCKED chapter's persisted snapshot (waiting_review locks the prose, so
// the snapshot is the truth during review).
// One top-level prose block: a stable id (from the block-id extension) + its
// plain text. Block-level checks anchor findings to these ids.
export interface ChapterBlock {
  id: string | null; // null = a block without a stable id (can't be anchored)
  text: string;
}

export interface ReviewContext {
  projectId: string;
  chapterId: string;
  title: string;
  summary: string;
  blocks: ChapterBlock[]; // the chapter body, block by block (mechanical checks)
  appears: string[]; // element names that appear (inline mentions)
  rulesKv: Record<string, string>; // storyline/project KV — auxiliary ground-truth
}

// One violation found. Becomes a single shadow-authored comment, anchored to a
// block (or chapter-level when blockId is null). Any finding sends the chapter
// back to draft.
export interface Finding {
  ruleId: string;
  itemId: string;
  blockId: string | null; // primary anchor block (becomes the comment's targetBlockId)
  blockIds?: string[]; // full consecutive range, when the finding spans blocks
  message: string;
  confidence: number; // 0..1 — below the engine threshold, dropped
  reason?: string; // short explanation of WHY it violates (semantic findings)
}

// One place a semantic assertion is violated. blockId null = a chapter-level /
// non-localizable violation. evidence quotes the offending text.
export interface SemanticViolation {
  blockIds: string[]; // the consecutive block range that violates ([] = chapter-level)
  reason: string; // WHY it violates the rule (an explanation, not a quote)
  confidence: number;
}

// Terminal verdict for a chapter review → drives the status transition. Clean →
// finished; any finding → back to draft (no separate revising tier; the user
// only ever sees draft / finished).
export type ShadowDecision = 'finished' | 'draft';

// The ONLY side-effect surface the graph may touch. Real impls live in deps.ts.
// Keeping these injected is what makes "advise-not-block" structural: the graph
// cannot edit prose — it can only read, write comments, and push status.
export interface ShadowDeps {
  readChapterSnapshot(chapterId: string): Promise<ReviewContext>;
  readRules(projectId: string, chapterId: string): Promise<RuleSpec[]>;
  evaluateSemantic(assertion: string, ctx: ReviewContext): Promise<SemanticViolation[]>;
  // Remove this chapter's prior shadow comments before writing the fresh batch,
  // so a re-review never piles up duplicates.
  clearComments(chapterId: string): Promise<void>;
  writeComment(chapterId: string, finding: Finding): Promise<void>;
  setStatus(chapterId: string, status: ShadowDecision): Promise<void>;
}

export interface ShadowJobInput {
  chapterId: string;
  projectId: string;
}

export interface ShadowJobResult {
  chapterId: string;
  decision: ShadowDecision;
  findingCount: number;
}

// Lifecycle signal pushed from the main-process worker to the renderer over the
// `shadow:job` channel as a review starts / finishes / fails. Drives the global
// notification feed (and, later, the persisted shadow_jobs row).
export interface ShadowJobEvent {
  chapterId: string;
  projectId: string;
  state: 'started' | 'completed' | 'failed';
  decision?: ShadowDecision;
  findingCount?: number;
  error?: string;
}
