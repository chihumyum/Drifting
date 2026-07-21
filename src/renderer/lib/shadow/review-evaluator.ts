import type {
  ChecklistItem,
  Finding,
  ReviewContext,
  RuleSpec,
  SemanticViolation,
  ShadowDeps,
} from './review-types';

const CONFIDENCE_MIN = 0.6;
const DETERMINISTIC = new Set(['word-count', 'must-appear', 'banned-words']);

function countChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

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
        const hit = words.filter((word) => word && block.text.includes(word));
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
      items.map((item) => item.assertion),
      ctx,
      { kind: rule.kind, judgingGuide: rule.judgingGuide },
    );
  } catch {
    // Keep the existing fail-safe semantics: a provider outage must unlock the
    // chapter by returning it to draft, with a visible retry finding.
    return items.map((item) => ({
      ruleId: rule.id,
      itemId: item.id,
      blockId: null,
      confidence: 1,
      message: `审阅未完成（LLM 暂不可用）：${item.assertion}`,
    }));
  }

  const findings: Finding[] = [];
  items.forEach((item, index) => {
    for (const violation of results[index] ?? []) {
      if (violation.confidence < CONFIDENCE_MIN) continue;
      findings.push({
        ruleId: rule.id,
        itemId: item.id,
        blockId: violation.blockIds[0] ?? null,
        blockIds: violation.blockIds,
        confidence: violation.confidence,
        message: item.assertion,
        reason: violation.reason,
      });
    }
  });
  return findings;
}

/** Evaluate rules in stable rule order; semantic checks remain batched per rule. */
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
