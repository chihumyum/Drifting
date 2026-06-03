import type { ChecklistItem, Finding, ReviewContext, RuleSpec, ShadowDeps } from './types';

// Findings below this confidence are dropped — the false-positive knob. Only the
// semantic evaluator produces sub-1 confidence; mechanical checks are exact.
const CONFIDENCE_MIN = 0.6;

function countChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Evaluate one compiled checklist item against the chapter. Block-localizable
// kinds (banned-words, semantic) return ONE finding per violating block, each
// anchored to its block id; chapter-global kinds (word-count, must-appear)
// return at most one chapter-level finding (blockId null).
async function evaluateItem(
  rule: RuleSpec,
  item: ChecklistItem,
  ctx: ReviewContext,
  evaluateSemantic: ShadowDeps['evaluateSemantic'],
): Promise<Finding[]> {
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
    case 'semantic':
    default: {
      let violations: Awaited<ReturnType<ShadowDeps['evaluateSemantic']>>;
      try {
        violations = await evaluateSemantic(item.assertion, ctx);
      } catch {
        // LLM unavailable — don't crash the whole review (that would leave the
        // chapter locked in waiting_review). Surface a chapter-level "couldn't
        // check" finding so the chapter falls back to draft and the author retries.
        return [{ ...base, confidence: 1, message: `审阅未完成（LLM 暂不可用）：${item.assertion}` }];
      }
      return violations
        .filter((v) => v.confidence >= CONFIDENCE_MIN)
        .map((v) => ({
          ...base,
          blockId: v.blockIds[0] ?? null,
          blockIds: v.blockIds,
          confidence: v.confidence,
          message: item.assertion,
          reason: v.reason,
        }));
    }
  }
}

// Run every rule's checklist against the chapter, collecting all findings.
export async function evaluateRules(
  rules: RuleSpec[],
  ctx: ReviewContext,
  evaluateSemantic: ShadowDeps['evaluateSemantic'],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of rules) {
    for (const item of rule.checklist) {
      findings.push(...(await evaluateItem(rule, item, ctx, evaluateSemantic)));
    }
  }
  return findings;
}
