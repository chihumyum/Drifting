/**
 * Certification gate — breaks the circularity of AI-writes-and-AI-judges. A
 * generated case's "correct answer" must be confirmed by an INDEPENDENT model (ideally
 * a stronger / different one than the eval judge) before it's trusted as ground truth.
 *
 * For a `shouldFlag:true` case the certifier must rule the injected fault a
 * **clear-violation** of the named rule given canon; for `shouldFlag:false` it must
 * rule **not-a-violation**. Anything **ambiguous** fails certification — only clean,
 * unambiguous labels enter the corpus. Canon is inlined here (certification judges
 * unambiguity, not consultation), so this is independent of the judge's tool path.
 */
import type { LLMClient } from '../../../ai/client/llm-client';
import type { AITool } from '../../../ai/types';
import { cloneProject } from '../model';
import { goldenToProject } from './load-golden';
import { caseToMutation } from './operators';
import type { EvalCase, GoldenFile } from './schema';

const CERT_MODEL = 'gemini-3.5-flash';
const PROSE_CAP = 16000;

export type Verdict = 'clear-violation' | 'ambiguous' | 'not-a-violation';

export interface Certification {
  caseId: string;
  verdict: Verdict;
  certified: boolean;
  confidence: number;
  reason: string;
}

const VERDICT_TOOL: AITool = {
  name: 'certify',
  description: '判断给定正文相对该规则是否构成明确违规，作为评测用例的 ground-truth 认证。',
  parametersSchema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['clear-violation', 'ambiguous', 'not-a-violation'],
        description: 'clear-violation=明确违反；not-a-violation=明确不违反；ambiguous=模棱两可',
      },
      confidence: { type: 'number', description: '0~1 把握' },
      reason: { type: 'string', description: '一句话依据' },
    },
    required: ['verdict', 'confidence', 'reason'],
  },
};

export interface CertifyOptions {
  model?: string;
  minConfidence?: number;
}

export async function certifyCase(
  golden: GoldenFile,
  c: EvalCase,
  certifier: LLMClient,
  opts: CertifyOptions = {},
): Promise<Certification> {
  const model = opts.model ?? CERT_MODEL;
  const minConfidence = opts.minConfidence ?? 0.7;

  // Apply the fault to a clone, then certify its PRIMARY expectation.
  const project = goldenToProject(golden);
  const clone = cloneProject(project);
  caseToMutation(c).apply(clone);
  const target = c.expect[0];
  const chapter = clone.chapters.find((ch) => ch.id === target.chapterId);
  const rule = clone.rules.find((r) => r.id === target.ruleId);
  if (!chapter || !rule) {
    return { caseId: c.id, verdict: 'ambiguous', certified: false, confidence: 0, reason: '目标章节/规则缺失' };
  }

  const assertion = rule.checklist.map((i) => i.assertion).join('\n');
  const canon =
    `全书设定：\n` +
    Object.entries(clone.facts)
      .map(([k, v]) => `- ${k}：${v}`)
      .join('\n') +
    `\n\n角色设定：\n` +
    clone.elements
      .map((e) => `- ${e.name}：${Object.entries(e.facts).map(([k, v]) => `${k}=${v}`).join('；')}`)
      .join('\n');
  let prose = chapter.blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
  if (prose.length > PROSE_CAP) prose = `${prose.slice(0, PROSE_CAP)}…（截断）`;

  const system =
    '你是独立的评测认证员。判断"在给定设定下，这一章正文是否明确违反该规则"。只有当违规明确无歧义时给 clear-violation；明确不违规给 not-a-violation；只要存在合理的另一种解读就给 ambiguous。宁可 ambiguous，不要勉强下结论。';
  const user = `规则：\n${assertion}\n\n${canon}\n\n正文（按段编号）：\n${prose}\n\n请调用 certify 给出裁决。`;

  const resp = await certifier.complete({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [VERDICT_TOOL],
    toolChoice: { force: 'certify' },
    thinking: false,
    metadata: { feature: 'shadow-eval-certify' },
  });

  const call = resp.toolCalls?.find((x) => x.name === 'certify') ?? resp.toolCall;
  const args = (call?.arguments ?? {}) as { verdict?: Verdict; confidence?: number; reason?: string };
  const verdict: Verdict = args.verdict ?? 'ambiguous';
  const confidence = Number(args.confidence ?? 0);
  const wanted: Verdict = target.shouldFlag ? 'clear-violation' : 'not-a-violation';
  const certified = verdict === wanted && confidence >= minConfidence;
  return { caseId: c.id, verdict, certified, confidence, reason: String(args.reason ?? '') };
}

export interface GrownCase {
  case: EvalCase; // enabled flips to `certified`; provenance records the verdict
  cert: Certification;
}

/** Generate (elsewhere) → certify → stamp. Certified cases come back `enabled:true`. */
export async function certifyAll(
  golden: GoldenFile,
  cases: EvalCase[],
  certifier: LLMClient,
  opts: CertifyOptions = {},
): Promise<GrownCase[]> {
  const out: GrownCase[] = [];
  for (const c of cases) {
    const cert = await certifyCase(golden, c, certifier, opts);
    out.push({
      case: {
        ...c,
        enabled: cert.certified,
        provenance: {
          ...(c.provenance ?? {}),
          certifiedBy: opts.model ?? CERT_MODEL,
          verdict: cert.verdict,
          certifyConfidence: cert.confidence,
        },
      },
      cert,
    });
  }
  return out;
}
