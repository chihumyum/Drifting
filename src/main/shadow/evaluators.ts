import type {
  ChecklistItem,
  Finding,
  ReviewContext,
  RuleSpec,
  SemanticViolation,
  ShadowDeps,
} from './types';

// Findings below this confidence are dropped — the false-positive knob. Only the
// semantic evaluator produces sub-1 confidence; mechanical checks are exact.
const CONFIDENCE_MIN = 0.6;

// Mechanical, non-LLM checklist kinds. Everything else (including any unrecognized
// type) is judged semantically — batched per rule, not routed through here.
const DETERMINISTIC = new Set(['word-count', 'must-appear', 'banned-words']);

function countChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Evaluate one DETERMINISTIC checklist item against the chapter. Block-localizable
// kinds (banned-words) return ONE finding per violating block, anchored to its
// block id; chapter-global kinds (word-count, must-appear) return at most one
// chapter-level finding (blockId null). Semantic items never reach here.
function evaluateDeterministic(rule: RuleSpec, item: ChecklistItem, ctx: ReviewContext): Finding[] {
  const base = { ruleId: rule.id, itemId: item.id, blockId: null as string | null };

  switch (item.type) {
    case 'word-count': {
      const target = Number(item.params?.target ?? 0);
      if (!target) return [];
      const tol = Number(item.params?.tol ?? 0);
      const n = countChars(ctx.blocks.map((b) => b.text).join(''));
      if (Math.abs(n - target) <= tol) return [];
      return [{ ...base, confidence: 1, message: `字数 ${n}，目标 ${target}±${tol}` }];
    }
    case 'must-appear': {
      const name = String(item.params?.element ?? '').trim();
      if (!name) return [];
      const present = ctx.appears.includes(name) || ctx.blocks.some((b) => b.text.includes(name));
      return present ? [] : [{ ...base, confidence: 1, message: `应出场但未出现：${name}` }];
    }
    case 'banned-words': {
      const words = toStringArray(item.params?.words);
      if (words.length === 0) return [];
      const findings: Finding[] = [];
      for (const block of ctx.blocks) {
        const hit = words.filter((w) => w && block.text.includes(w));
        if (hit.length > 0) {
          findings.push({
            ...base,
            blockId: block.id,
            blockIds: block.id ? [block.id] : [],
            confidence: 1,
            message: `出现禁用词：${hit.join('、')}`,
          });
        }
      }
      return findings;
    }
    default:
      return [];
  }
}

// Judge a rule's SEMANTIC items together — one shared evidence loop per rule. Its
// related checks share context (canon + reasoning), so gathering once beats
// re-fetching per item; verdicts stay per-item (mapped back by index). Different
// rules run in different loops → no cross-rule verdict contamination.
async function evaluateRuleSemantics(
  rule: RuleSpec,
  items: ChecklistItem[],
  ctx: ReviewContext,
  evaluateSemanticBatch: ShadowDeps['evaluateSemanticBatch'],
): Promise<Finding[]> {
  if (items.length === 0) return [];
  let results: SemanticViolation[][];
  try {
    results = await evaluateSemanticBatch(
      items.map((i) => i.assertion),
      ctx,
      { kind: rule.kind, judgingGuide: rule.judgingGuide },
    );
  } catch {
    // LLM unavailable — don't crash the whole review (that would leave the chapter
    // locked in waiting_review). Surface one chapter-level "couldn't check" finding
    // per item so the chapter falls back to draft and the author retries.
    return items.map((item) => ({
      ruleId: rule.id,
      itemId: item.id,
      blockId: null,
      confidence: 1,
      message: `审阅未完成（LLM 暂不可用）：${item.assertion}`,
    }));
  }
  const findings: Finding[] = [];
  items.forEach((item, idx) => {
    for (const v of results[idx] ?? []) {
      if (v.confidence < CONFIDENCE_MIN) continue;
      findings.push({
        ruleId: rule.id,
        itemId: item.id,
        blockId: v.blockIds[0] ?? null,
        blockIds: v.blockIds,
        confidence: v.confidence,
        message: item.assertion,
        reason: v.reason,
      });
    }
  });
  return findings;
}

// Run every rule's checklist against the chapter, collecting all findings. Within
// each rule, deterministic items run inline and the semantic items share ONE FC
// loop (so 分幕→每幕POV→禁止头跳 reuse the same act segmentation instead of each
// rediscovering it).
export async function evaluateRules(
  rules: RuleSpec[],
  ctx: ReviewContext,
  evaluateSemanticBatch: ShadowDeps['evaluateSemanticBatch'],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const semantic: ChecklistItem[] = [];
    for (const item of rule.checklist) {
      if (DETERMINISTIC.has(item.type)) findings.push(...evaluateDeterministic(rule, item, ctx));
      else semantic.push(item);
    }
    findings.push(...(await evaluateRuleSemantics(rule, semantic, ctx, evaluateSemanticBatch)));
  }
  return findings;
}
