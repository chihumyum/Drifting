/**
 * AI fault generator — proposes eval cases as DATA (not code). The model gets the
 * golden's chapters/elements/rules + the fixed operator vocabulary and returns
 * candidate cases via a forced `propose_faults` tool call. Every candidate is then
 * VALIDATED against the real registry: zod case shape → operator param schema →
 * the drift guard (declared `expect` must equal what the operator computes) → and
 * `apply` must run on a clone without throwing. Invalid candidates are dropped, so
 * a generated case is structurally as trustworthy as a hand-written one.
 *
 * Candidates come back `enabled:false` + provenance `ai-generated` — they are NOT
 * trusted as ground truth until certify.ts passes them (an independent model).
 */
import type { LLMClient } from '../../../ai/client/llm-client';
import type { AITool } from '../../../ai/types';
import { cloneProject } from '../model';
import { goldenToProject } from './load-golden';
import { OPERATOR_IDS, caseToMutation } from './operators';
import { zCase, type EvalCase, type GoldenFile } from './schema';

const GEN_MODEL = 'gemini-3.5-flash'; // non-deepseek id ⇒ provider substitutes its default

const OPERATOR_GUIDE = `可用 operator（用 op + params 引用，禁止臆造别的）：
- injectBlock {chapterId, text, ruleId, label?}：在该章末尾追加一段"违反 ruleId"的正文。expect=[{chapterId,ruleId,shouldFlag:true}]。
- contradictInProse {chapterId, blockId, find, replace, ruleId}：把某段里的 find 改成 replace，使其与设定冲突。expect=[{chapterId,ruleId,true}]。
- changeDependency {elementName, factKey, newValue, affected:[{chapterId,ruleId}]}：只改某元素的一条设定(正文不动)，使依赖它的章节变违规。expect=affected 全 true。
- changeDependencyIrrelevant {elementName, factKey, newValue, control:[{chapterId,ruleId}]}：改一条无关设定→必须仍然通过(误报闸)。expect=control 全 false。`;

const PROPOSE_TOOL: AITool = {
  name: 'propose_faults',
  description: '一次性提出若干"按构造为真"的故障注入用例。每个 case 必须可由 op+params 机械执行，且 expect 与该 operator 的语义严格一致。',
  parametersSchema: {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        description: '候选用例列表',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '稳定短 id，如 gen-pov-1' },
            op: { type: 'string', enum: OPERATOR_IDS, description: 'operator id' },
            params: { type: 'object', description: '该 operator 的参数（见说明）' },
            expect: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chapterId: { type: 'string' },
                  ruleId: { type: 'string' },
                  shouldFlag: { type: 'boolean' },
                },
                required: ['chapterId', 'ruleId', 'shouldFlag'],
              },
            },
            rationale: { type: 'string', description: '为何这是按构造为真的故障（一句话）' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'op', 'params', 'expect', 'rationale'],
        },
      },
    },
    required: ['cases'],
  },
};

function describeGolden(g: GoldenFile): string {
  const chapters = g.project.chapters.map((c) => `  - ${c.id}「${c.title}」${c.summary ?? ''}`).join('\n');
  const elements = g.project.elements
    .map((e) => `  - ${e.name}: ${Object.entries(e.facts).map(([k, v]) => `${k}=${v}`).join('；')}`)
    .join('\n');
  const rules = g.project.rules
    .map((r) => `  - ${r.id}: ${r.checklist.map((i) => i.assertion).join(' / ')}`)
    .join('\n');
  return `章节：\n${chapters}\n\n元素设定：\n${elements}\n\n规则：\n${rules}`;
}

export interface GenerateOptions {
  n?: number;
  model?: string;
}

export async function generateCases(
  golden: GoldenFile,
  client: LLMClient,
  opts: GenerateOptions = {},
): Promise<EvalCase[]> {
  const project = goldenToProject(golden);
  const n = opts.n ?? 6;
  const model = opts.model ?? GEN_MODEL;

  const system = [
    '你是小说写作 CI 的"故障注入"出题器。给定一个 golden 项目（设定干净、无违规），请提出若干用例，每个都是"按构造为真"的故障：要么注入一段确实违反某规则的正文，要么改动某条设定让依赖它的正文变违规，或一个无关改动作为误报闸。',
    OPERATOR_GUIDE,
    '要求：用例必须只引用上面列出的章节 id / 元素名 / 规则 id；params 字段名必须与 operator 完全一致；expect 必须与 operator 语义一致（注入/正文冲突/依赖改动→true；无关改动→false）。优先产出语义类（injectBlock / contradictInProse / changeDependency）。多样化覆盖不同规则与元素。',
  ].join('\n\n');

  const user = `golden = ${golden.id}\n\n${describeGolden(golden)}\n\n请调用 propose_faults 提出 ${n} 个互不相同的用例。`;

  const resp = await client.complete({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [PROPOSE_TOOL],
    toolChoice: { force: 'propose_faults' },
    thinking: false, // forced tool_choice + thinking = 400 on DeepSeek
    metadata: { feature: 'shadow-eval-gen' },
  });

  const call = resp.toolCalls?.find((c) => c.name === 'propose_faults') ?? resp.toolCall;
  const raw = ((call?.arguments as { cases?: unknown[] })?.cases ?? []) as Record<string, unknown>[];

  const out: EvalCase[] = [];
  for (const c of raw) {
    const candidate = {
      id: String(c.id ?? ''),
      golden: golden.id,
      op: c.op as string | undefined,
      params: c.params,
      expect: c.expect,
      tags: c.tags as string[] | undefined,
      enabled: false,
      provenance: {
        origin: 'ai-generated',
        model,
        rationale: c.rationale,
      },
    };
    try {
      const parsed = zCase.parse(candidate);
      const mut = caseToMutation(parsed); // zod params + drift-guard
      const clone = cloneProject(project);
      mut.apply(clone); // must run on THIS golden without throwing
      out.push(parsed);
    } catch (e) {
      console.warn(`[gen] 丢弃候选 "${candidate.id}"：${(e as Error).message}`);
    }
  }
  return out;
}
