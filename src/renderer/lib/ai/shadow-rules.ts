import { buildDefaultLLMClient } from './client/build-default-client';
import { callStructured } from './call-structured';
import { resolveWritingLanguage } from './output-language';
import { shadowRuleCompilePrompt } from './prompts/templates/shadow-rule-compile';
import { shadowSemanticEvalPrompt } from './prompts/templates/shadow-semantic-eval';
import { shadowSemanticAgenticPrompt } from './prompts/templates/shadow-semantic-agentic';
import type { LLMClient } from './client/llm-client';
import type { AIMessage, AITool, AIToolCall } from './types';
import type { ChecklistItem } from '../../domain/project-rule';

// Stable, cheap hash of a rule's source text — lets callers skip recompiling
// when rawContent is unchanged (compiledFromHash on the row).
export function hashRuleContent(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

let itemCounter = 0;
function nextItemId(): string {
  itemCounter += 1;
  return `ci_${Date.now().toString(36)}_${itemCounter}`;
}

// Compile one freeform rule into a checklist of atomic, typed assertions via the
// LLM normalizer (reuses the renderer AI substrate → DeepSeek by default).
// Returns [] for blank input. Each item gets a fresh local id.
export async function compileRule(
  rawContent: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ChecklistItem[]> {
  const rule = rawContent.trim();
  if (!rule) return [];

  const client = await buildDefaultLLMClient();
  const out = await callStructured(
    client,
    shadowRuleCompilePrompt,
    { rule },
    { outputLanguage: resolveWritingLanguage(projectId), signal },
  );

  return out.checklist.map((item) => ({
    id: nextItemId(),
    assertion: item.assertion,
    type: item.type,
    params: item.params ? (item.params as Record<string, unknown>) : undefined,
  }));
}

export interface SemanticViolation {
  blockIds: string[];
  reason: string;
  confidence: number;
}

// Background the semantic judge gets alongside the prose: project/storyline facts
// (POV, writing person, character setup…) + the chapter summary. Grounds deep
// rules so the model judges with context instead of guessing.
export interface SemanticEvalContext {
  facts?: Record<string, string>;
  summary?: string;
}

function buildBackground(context?: SemanticEvalContext): string {
  const lines: string[] = [];
  if (context?.summary?.trim()) lines.push(`本章梗概：${context.summary.trim()}`);
  const factLines = Object.entries(context?.facts ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    .map(([k, v]) => `- ${k}：${v}`);
  if (factLines.length > 0) lines.push(`设定/事实：\n${factLines.join('\n')}`);
  return lines.length > 0 ? lines.join('\n') : '（无额外背景）';
}

// Judge one semantic assertion against a chapter's NUMBERED blocks via the LLM
// substrate, grounded in `context` (facts + summary). Returns one violation per
// offending consecutive span (blockIds = the span's block ids; [] = chapter-level).
// Only entries the model marks `violated` are kept (drops "satisfied" padding).
export async function evaluateSemanticAssertion(
  assertion: string,
  blocks: { id: string | null; text: string }[],
  projectId: string,
  context?: SemanticEvalContext,
  signal?: AbortSignal,
): Promise<SemanticViolation[]> {
  if (!assertion.trim() || blocks.length === 0) return [];
  const client = await buildDefaultLLMClient();
  const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
  const out = await callStructured(
    client,
    shadowSemanticEvalPrompt,
    { assertion, blocks: numbered, context: buildBackground(context) },
    { outputLanguage: resolveWritingLanguage(projectId), signal },
  );
  return mapViolations(out.violations, blocks);
}

// The judge's raw per-span verdict, as both eval prompts return it.
interface RawViolation {
  violated: boolean;
  blockStart: number;
  blockEnd: number;
  reason: string;
  confidence: number;
}

// Shared: map the model's 1-based block-range verdict to concrete block ids.
function mapViolations(
  violations: RawViolation[],
  blocks: { id: string | null; text: string }[],
): SemanticViolation[] {
  return violations
    .filter((v) => v.violated)
    .map((v) => {
      const start = Math.max(1, Math.floor(v.blockStart));
      const end = Math.max(start, Math.floor(v.blockEnd));
      const blockIds =
        v.blockStart >= 1
          ? blocks
              .slice(start - 1, Math.min(end, blocks.length))
              .map((b) => b.id)
              .filter((id): id is string => !!id)
          : [];
      return { blockIds, reason: v.reason, confidence: v.confidence };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agentic (evidence-gathering) semantic judge.
//
// The shadow judge no longer gets a fixed, pre-baked background. It runs a loop:
// each round it either rules, or asks for canon it needs first (an element
// profile, an element's cross-chapter evolution, a free-floating drift node's
// full text, or another chapter's prose). The harness fetches the request with
// the project's existing read tools and re-invokes — so deep rules ground
// themselves in exactly the facts they need, while shallow rules still rule in
// one round (no cost regression). The renderer owns the data, so it injects an
// EvidenceProvider; this module stays pure orchestration + LLM.

// What evidence the judge can ask for. `kind` is validated/normalized from the
// model's free string; unknown kinds are dropped by the harness.
export type EvidenceKind = 'element' | 'element_evolution' | 'drift' | 'chapter';

export interface EvidenceRequest {
  kind: EvidenceKind;
  name: string;
}

// The cheap, always-shown menu the judge picks from. Summaries are the first tier
// of progressive disclosure: the judge reads a drift/chapter summary here and only
// requests the full text when it looks relevant.
export interface EvidenceCatalog {
  sceneEntities: { name: string; summary?: string }[]; // elements appearing in this chapter
  driftNodes: { title: string; summary?: string }[]; // free-floating drift nodes (settings/rules)
  priorChapter?: { title: string; summary?: string }; // the immediately-preceding chapter
}

// The renderer-side data surface the loop pulls from. Mirrors the LangGraph
// ShadowDeps pattern: the only contact with the DB/Yjs world, injected so this
// module is testable and never imports a repo.
export interface EvidenceProvider {
  catalog(): Promise<EvidenceCatalog>;
  // Fetch one request as already-formatted, human-readable text (handed straight
  // to the model). Returns null when the target can't be found.
  fetch(req: EvidenceRequest): Promise<string | null>;
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['element', 'element_evolution', 'drift', 'chapter'];
const MAX_ROUNDS = 4; // judge gets at most this many evidence rounds before a forced verdict
const MAX_REQUESTS_PER_ROUND = 4;

function normalizeKind(raw: string): EvidenceKind | null {
  const k = raw.trim().toLowerCase();
  return (EVIDENCE_KINDS as readonly string[]).includes(k) ? (k as EvidenceKind) : null;
}

function renderCatalog(cat: EvidenceCatalog): string {
  const lines: string[] = [];
  if (cat.sceneEntities.length > 0) {
    lines.push('出场 element（可 element / element_evolution 索取详情）：');
    for (const e of cat.sceneEntities) {
      lines.push(`- ${e.name}${e.summary ? `：${e.summary}` : ''}`);
    }
  }
  if (cat.driftNodes.length > 0) {
    lines.push('drift 节点（可能含设定集/规则；先看 summary，相关再 drift 索取全文）：');
    for (const d of cat.driftNodes) {
      lines.push(`- ${d.title}${d.summary ? `：${d.summary}` : ''}`);
    }
  }
  if (cat.priorChapter) {
    lines.push(
      `前一章（可 chapter 索取全文核对连续性）：\n- ${cat.priorChapter.title}${cat.priorChapter.summary ? `：${cat.priorChapter.summary}` : ''}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : '（无可用证据）';
}

/**
 * Judge one semantic assertion with on-demand evidence gathering. Falls back to
 * the single-shot path when no provider is given (unit tests / disabled). The
 * loop caps rounds and dedupes fetches so a review stays bounded.
 */
// A readable trail step from the judge's loop — surfaced to the shadow job
// recorder so the panel can show what evidence it pulled and how it ruled.
export interface AgenticTraceStep {
  label: string;
  detail?: string;
  items?: string[];
}

export async function evaluateSemanticAssertionAgentic(
  assertion: string,
  blocks: { id: string | null; text: string }[],
  projectId: string,
  context: SemanticEvalContext | undefined,
  provider: EvidenceProvider | undefined,
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<SemanticViolation[]> {
  if (!assertion.trim() || blocks.length === 0) return [];
  if (!provider) {
    return evaluateSemanticAssertion(assertion, blocks, projectId, context, signal);
  }

  const client = await buildDefaultLLMClient();
  const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
  const background = buildBackground(context);
  const catalogText = renderCatalog(await provider.catalog());
  const outputLanguage = resolveWritingLanguage(projectId);

  const fetched = new Map<string, string>(); // key `${kind}:${name}` → formatted evidence
  const evidenceLog: string[] = [];

  // Emit a "裁决" trail step from a verdict, then return the mapped violations.
  const settle = (violations: RawViolation[]): SemanticViolation[] => {
    const mapped = mapViolations(violations, blocks);
    onTrace?.({
      label: mapped.length ? '裁决：发现违反' : '裁决：通过',
      items: mapped.length ? mapped.map((v) => v.reason).filter(Boolean) : undefined,
    });
    return mapped;
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const mustDecide = round === MAX_ROUNDS;
    const out = await callStructured(
      client,
      shadowSemanticAgenticPrompt,
      {
        assertion,
        context: background,
        blocks: numbered,
        catalog: catalogText,
        evidence: evidenceLog.join('\n\n'),
        mustDecide,
      },
      { outputLanguage, signal },
    );

    if (out.done || mustDecide || out.requests.length === 0) {
      return settle(out.violations);
    }

    // Fetch this round's (deduped, capped) requests and append to the evidence log.
    let added = 0;
    const traceLines: string[] = [];
    for (const r of out.requests) {
      if (added >= MAX_REQUESTS_PER_ROUND) break;
      const kind = normalizeKind(r.kind);
      const name = String(r.name ?? '').trim();
      if (!kind || !name) continue;
      const key = `${kind}:${name}`;
      if (fetched.has(key)) continue;
      let text: string | null = null;
      try {
        text = await provider.fetch({ kind, name });
      } catch {
        text = null; // a bad fetch must never abort the review
      }
      const found = text != null;
      const value = text ?? `（未找到：${kind} ${name}）`;
      fetched.set(key, value);
      evidenceLog.push(`【${kind} · ${name}】\n${value}`);
      const why = String(r.why ?? '').trim();
      traceLines.push(`${kind} · ${name}${why ? ` — ${why}` : ''}${found ? '' : '（未找到）'}`);
      added += 1;
    }
    if (traceLines.length) onTrace?.({ label: `取证 · 第 ${round} 轮`, items: traceLines });

    // Nothing new could be fetched — avoid spinning; force a verdict next round.
    if (added === 0) {
      const out2 = await callStructured(
        client,
        shadowSemanticAgenticPrompt,
        {
          assertion,
          context: background,
          blocks: numbered,
          catalog: catalogText,
          evidence: evidenceLog.join('\n\n'),
          mustDecide: true,
        },
        { outputLanguage, signal },
      );
      return settle(out2.violations);
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Function-calling (FC) semantic judge — the freer cousin of the Path-A loop.
//
// On an OpenAI-compatible substrate that supports a real tool loop, the judge
// gets the project's READ tools (read_element, search_prose, get_node_context,
// …) and calls whatever it needs, in any order, with free arguments — then calls
// the terminal `submit_verdict` tool to rule. We (the harness) execute each tool,
// thread results back as tool messages, and enforce guardrails: a hard cap on
// tool calls, a round cap, result truncation, and a forced submit at the end.
// Strictly READ tools (caller passes a read-only set) keeps advise-not-block.

const FC_MAX_TOOL_CALLS = 10; // total evidence fetches before we force a verdict
const FC_MAX_ROUNDS = 12; // model turns
const FC_MODEL = 'gemini-3.5-flash'; // non-deepseek id ⇒ provider substitutes its configured default
const FC_RESULT_MAX = 2000; // chars per tool result fed back

export const SUBMIT_VERDICT_TOOL: AITool = {
  name: 'submit_verdict',
  description:
    '证据已足够，提交本条约束的最终裁决。整章都满足时 violations 为空数组。只把确实违反的段落写进去，不确定/依据不足一律不写。',
  parametersSchema: {
    type: 'object',
    properties: {
      violations: {
        type: 'array',
        description: '违反的连续段范围列表；无违反则为空数组',
        items: {
          type: 'object',
          properties: {
            violated: { type: 'boolean', description: 'true=该段确实违反' },
            blockStart: { type: 'number', description: '起始段编号(1 起);0=整章级' },
            blockEnd: { type: 'number', description: '结束段编号(含);单段时同 blockStart' },
            reason: { type: 'string', description: '一句话解释为何违反(不要照抄原文)' },
            confidence: { type: 'number', description: '0~1 把握' },
          },
          required: ['violated', 'blockStart', 'blockEnd', 'reason', 'confidence'],
        },
      },
    },
    required: ['violations'],
  },
};

function coerceVerdict(args: unknown): RawViolation[] {
  const raw = (args as { violations?: unknown })?.violations;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      violated: o.violated === true,
      blockStart: Number(o.blockStart ?? 0),
      blockEnd: Number(o.blockEnd ?? 0),
      reason: String(o.reason ?? ''),
      confidence: Number(o.confidence ?? 0),
    };
  });
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const vals = Object.values(args as Record<string, unknown>)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v));
  return vals.join(' ');
}

export async function evaluateSemanticAssertionFC(
  assertion: string,
  blocks: { id: string | null; text: string }[],
  projectId: string,
  context: SemanticEvalContext | undefined,
  client: LLMClient,
  readTools: AITool[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<SemanticViolation[]> {
  if (!assertion.trim() || blocks.length === 0) return [];

  const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
  const outputLanguage = resolveWritingLanguage(projectId);
  const tools = [...readTools, SUBMIT_VERDICT_TOOL];

  const system = [
    '你是小说写作 CI 的取证式审阅器。给你一条「约束」和一章正文(按段编号)。',
    '你可以调用只读工具去查设定(角色档案与 facts、元素演变、drift 设定、关系、前文、全文检索),把约束判准。',
    '查够了就调用 submit_verdict 给出最终裁决。克制取证:能直接判就别查;只查真正影响判断的;不要重复查同一样东西。',
    '裁决规则:只把确实违反的连续段写进 violations(blockStart/blockEnd 含两端,整章级用 0);不确定一律不写;宁可漏报别误报;整章满足则空数组。',
    `用 ${outputLanguage} 写所有自然语言输出(reason 等)。`,
  ].join('\n');

  const messages: AIMessage[] = [
    {
      role: 'user',
      content: `约束：${assertion}\n\n背景设定：\n${buildBackground(context)}\n\n正文(按段编号)：\n${numbered}`,
    },
  ];

  let toolCalls = 0;
  for (let round = 0; round < FC_MAX_ROUNDS; round++) {
    const force = toolCalls >= FC_MAX_TOOL_CALLS || round === FC_MAX_ROUNDS - 1;
    const resp = await client.complete({
      model: FC_MODEL,
      system,
      messages,
      tools,
      toolChoice: force ? { force: 'submit_verdict' } : 'auto',
      thinking: false, // forced tool_choice + thinking = 400 on DeepSeek; judge doesn't need it
      signal,
      metadata: { feature: 'shadow-semantic-fc' },
    });

    const calls: AIToolCall[] = resp.toolCalls ?? (resp.toolCall ? [resp.toolCall] : []);
    if (calls.length === 0) {
      // Model answered in prose without calling submit — nudge it to rule.
      messages.push({ role: 'model', content: resp.text ?? '' });
      messages.push({ role: 'user', content: '请调用 submit_verdict 提交裁决。' });
      continue;
    }

    messages.push({ role: 'model', content: resp.text ?? '', toolCalls: calls });

    const traceItems: string[] = [];
    for (const call of calls) {
      if (call.name === 'submit_verdict') {
        const mapped = mapViolations(coerceVerdict(call.arguments), blocks);
        onTrace?.({
          label: mapped.length ? '裁决：发现违反' : '裁决：通过',
          items: mapped.length ? mapped.map((v) => v.reason).filter(Boolean) : undefined,
        });
        return mapped;
      }
      toolCalls += 1;
      const argRecord =
        call.arguments && typeof call.arguments === 'object'
          ? (call.arguments as Record<string, unknown>)
          : {};
      let result: string;
      try {
        result = await runTool(call.name, argRecord);
      } catch (e) {
        result = `（工具错误：${e instanceof Error ? e.message : String(e)}）`;
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: result.length > FC_RESULT_MAX ? `${result.slice(0, FC_RESULT_MAX)}…（截断）` : result,
      });
      traceItems.push(`${call.name} ${summarizeArgs(call.arguments)}`.trim());
    }
    if (traceItems.length) onTrace?.({ label: `查证 · 第 ${round + 1} 轮`, items: traceItems });
  }
  return [];
}
