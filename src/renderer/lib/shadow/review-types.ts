/**
 * Platform-neutral contracts for a Shadow chapter review.
 *
 * This lives beside the renderer-owned data/Yjs/LLM substrate so the same engine
 * runs in a Tauri desktop or mobile webview without an IPC round trip.
 */
export type ChecklistItemType = 'word-count' | 'must-appear' | 'banned-words' | 'semantic';

export interface ChecklistItem {
  id: string;
  assertion: string;
  type: ChecklistItemType;
  params?: Record<string, unknown>;
}

export type RuleKind = 'consistency' | 'continuity' | 'structure' | 'style' | 'other';

export interface RuleSpec {
  id: string;
  checklist: ChecklistItem[];
  kind?: RuleKind;
  judgingGuide?: string;
}

export interface ChapterBlock {
  id: string | null;
  text: string;
}

export interface ReviewContext {
  projectId: string;
  chapterId: string;
  title: string;
  summary: string;
  blocks: ChapterBlock[];
  appears: string[];
  rulesKv: Record<string, string>;
}

export interface Finding {
  ruleId: string;
  itemId: string;
  blockId: string | null;
  blockIds?: string[];
  message: string;
  confidence: number;
  reason?: string;
}

export interface SemanticViolation {
  blockIds: string[];
  reason: string;
  confidence: number;
}

export type ShadowDecision = 'finished' | 'draft';

/** The only mutation surface available to the review pipeline. */
export interface ShadowDeps {
  readChapterSnapshot(chapterId: string): Promise<ReviewContext>;
  readRules(projectId: string, chapterId: string): Promise<RuleSpec[]>;
  evaluateSemanticBatch(
    assertions: string[],
    ctx: ReviewContext,
    rule?: { kind?: RuleKind; judgingGuide?: string },
  ): Promise<SemanticViolation[][]>;
  commitReview(chapterId: string, findings: Finding[], status: ShadowDecision): Promise<void>;
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

export interface ShadowJobEvent {
  chapterId: string;
  projectId: string;
  state: 'started' | 'completed' | 'failed';
  decision?: ShadowDecision;
  findingCount?: number;
  error?: string;
}
