// Domain: ProjectRule — a project-owned review rule the shadow CI checks
// chapters against. Authoring is FREEFORM (rawContent); an LLM normalizer
// compiles it into a checklist of atomic assertions, each with an INFERRED
// `type`. See schema/drizzle.ts ProjectRuleTable.

export type RuleSource = 'project' | 'drift';

// The rule's overall category, inferred by the enhancement compiler. Drives which
// judging guidance applies; 'consistency' rules carry the canon-truth policy.
export type RuleKind = 'consistency' | 'continuity' | 'structure' | 'style' | 'other';

// Atomic, individually-checkable assertion compiled from a rule. `type` is
// inferred by the normalizer (the author never picks it): mechanical kinds route
// to deterministic evaluators; 'semantic' routes to the LLM evaluator.
export type ChecklistItemType = 'word-count' | 'must-appear' | 'banned-words' | 'semantic';

export interface ChecklistItem {
  id: string;
  assertion: string;
  type: ChecklistItemType;
  params?: Record<string, unknown>;
}

// Narrows which chapters a rule applies to. null/empty = whole project.
export interface RuleScope {
  storylineIds?: string[];
  nodeIds?: string[];
  elementIds?: string[];
}

export interface ProjectRule {
  id: string;
  projectId: string;
  rawContent: string;
  checklist: ChecklistItem[];
  // Enhancement-compiler outputs (see lib/ai/prompts/templates/shadow-rule-compile).
  // `kind` routes judging; `judgingGuide` is the LLM-authored, author-editable judging
  // template injected into the Shadow judge's prompt when this rule is evaluated.
  kind: RuleKind;
  judgingGuide: string;
  compiledFromHash: string;
  scope: RuleScope | null;
  enabled: boolean;
  source: RuleSource;
  sourceDriftId: string | null;
  sourceDriftHash: string | null;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}
