import { buildDefaultLLMClient } from './client/build-default-client';
import { callStructured } from './call-structured';
import { resolveWritingLanguage } from './output-language';
import { shadowRuleCompilePrompt } from './prompts/templates/shadow-rule-compile';
import { shadowSemanticEvalPrompt } from './prompts/templates/shadow-semantic-eval';
import { shadowSemanticAgenticPrompt } from './prompts/templates/shadow-semantic-agentic';
import type { LLMClient } from './client/llm-client';
import type { AIMessage, AITool, AIToolCall, AIUsage } from './types';
import type { ChecklistItem, RuleKind } from '../../domain/project-rule';
import type { ShadowToolCall, ShadowToolStatus } from '../../domain/shadow-job';
import { yieldToMain } from '../async/yield-to-main';

// What the FC judge's tool executor returns: the result text fed back to the
// model + the outcome status surfaced to the trace (ok / denied / error).
export interface ToolRunOutcome {
  content: string;
  status: ShadowToolStatus;
  note?: string;
}

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

// The enhancement-compiler output for one rule: the atomic checklist PLUS the inferred
// kind and the LLM-authored judging template (injected into the judge's prompt).
export interface CompiledRule {
  checklist: ChecklistItem[];
  kind: RuleKind;
  judgingGuide: string;
}

// Compile one freeform rule into {checklist, kind, judgingGuide} via the LLM enhancement
// compiler (reuses the renderer AI substrate → DeepSeek by default). Blank input → empty.
// Each checklist item gets a fresh local id.
export async function compileRule(
  rawContent: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<CompiledRule> {
  const rule = rawContent.trim();
  if (!rule) return { checklist: [], kind: 'other', judgingGuide: '' };

  const client = await buildDefaultLLMClient();
  const out = await callStructured(
    client,
    shadowRuleCompilePrompt,
    { rule },
    { outputLanguage: resolveWritingLanguage(projectId), signal },
  );

  return {
    checklist: out.checklist.map((item) => ({
      id: nextItemId(),
      assertion: item.assertion,
      type: item.type,
      params: item.params ? (item.params as Record<string, unknown>) : undefined,
    })),
    kind: out.kind,
    judgingGuide: out.judgingGuide ?? '',
  };
}

export interface SemanticViolation {
  blockIds: string[];
  reason: string;
  confidence: number;
}

// Background the semantic judge gets alongside the prose: whole-book (project)
// facts + the chapter summary + the chapter's storyline (its own summary/facts).
// (POV, writing person, character setup…). Grounds deep rules so the model judges
// with context instead of guessing.
export interface SemanticEvalContext {
  facts?: Record<string, string>;
  summary?: string;
  // The storyline this chapter primarily belongs to — its own summary and KV
  // facts, fed ALONGSIDE (not merged into) the whole-book facts so the judge can
  // tell book-wide canon from this arc's local canon.
  storyline?: { name?: string; summary?: string; facts?: Record<string, string> };
  // Chapter IDENTITY — so the judge KNOWS which node it is reviewing and can
  // address it by name with the read tools, instead of guessing node titles
  // (`read_node 未知章节`) or re-searching the project for its own prose.
  identity?: { title: string; kind: 'chapter' | 'drift'; position?: string };
  // Warm-start hints so deep rules don't burn rounds rediscovering the obvious:
  // who's actually on stage (prose-scanned, NOT just linked mentions — bare-name
  // protagonists were being missed), the prior chapter, and drift settings. All
  // summary-level (cheap); full bodies are still fetched on demand.
  sceneEntities?: { name: string; summary?: string }[];
  priorChapter?: { title: string; summary?: string };
  driftNodes?: { title: string; summary?: string }[];
  // Dep-graph recheck hint: canon nodes edited since this chapter was last reviewed.
  // The judge is told WHICH settings moved (name + optional field), and optionally the
  // old→new VALUE diff (from/to) — never that a fault EXISTS in the prose (no answer
  // leak). from/to is exactly what the staleness/diff layer holds in prod. Populated by
  // that layer (and, in eval, by the changeDependency operator).
  changedDeps?: ChangedDepHint[];
  // Per-rule judging template (LLM-authored by the enhancement compiler, author-editable)
  // + the rule's kind. `judgingGuide` is injected into the judge's prompt for THIS rule
  // (replaces the global heuristic canon-truth injection). See shadow/DESIGN.md §6/④.
  ruleKind?: string;
  judgingGuide?: string;
}

// One changed-canon pointer forwarded to the judge. `fact` = which field moved;
// `from`/`to` = the old→new value diff (omitted ⇒ pointer-level hint). See
// buildChangedDepsHint for how it renders; computed in prod by lib/shadow/dep-snapshot.
export interface ChangedDepHint {
  name: string;
  fact?: string;
  from?: string;
  to?: string;
}

function buildBackground(context?: SemanticEvalContext): string {
  const lines: string[] = [];
  if (context?.summary?.trim()) lines.push(`本章梗概：${context.summary.trim()}`);
  const factLines = (facts?: Record<string, string>) =>
    Object.entries(facts ?? {})
      .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
      .map(([k, v]) => `- ${k}：${v}`);
  const bookFacts = factLines(context?.facts);
  if (bookFacts.length > 0) lines.push(`全书设定/事实：\n${bookFacts.join('\n')}`);
  // The chapter's storyline, fed as its own section so its local canon doesn't
  // masquerade as book-wide fact.
  const sl = context?.storyline;
  if (sl) {
    const label = sl.name?.trim() ? `本章所属故事线《${sl.name.trim()}》` : '本章所属故事线';
    if (sl.summary?.trim()) lines.push(`${label}梗概：${sl.summary.trim()}`);
    const slFacts = factLines(sl.facts);
    if (slFacts.length > 0) lines.push(`${label}设定/事实：\n${slFacts.join('\n')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '（无额外背景）';
}

// A consistency-recheck hint built from the dep-graph: which canon nodes were edited
// since this chapter was last reviewed. We name WHICH settings moved (name + field) —
// NOT the old/new value, NOT that a violation exists — and ask the judge to re-verify
// the prose against CURRENT canon. The anti-over-fire clause keeps a merely-irrelevant
// change from inducing a false positive.
function buildChangedDepsHint(context?: SemanticEvalContext): string {
  const deps = (context?.changedDeps ?? []).filter((d) => d.name?.trim());
  if (!deps.length) return '';
  // Pointer level → "X（字段：Y）"; diff level → "X（字段：Y）：由「旧」改为「新」". The
  // diff is the value the engine actually holds; it discloses the change, not a verdict.
  const list = deps
    .map((d) => {
      const head = d.fact?.trim() ? `${d.name}（字段：${d.fact.trim()}）` : d.name;
      const hasDiff = (d.from?.trim() ?? '') !== '' || (d.to?.trim() ?? '') !== '';
      return hasDiff ? `${head}：由「${d.from?.trim() || '（空）'}」改为「${d.to?.trim() || '（空）'}」` : head;
    })
    .join('\n');
  return [
    '【一致性复核提示】以下设定/事实自本章上次审阅后被改动过，请重点核对本章正文是否仍与它们的【当前】值一致：',
    list,
    '若正文与当前设定确有冲突，按相关约束报出；若并不冲突，照常放过——不要因为被提示就强行找茬（仍然宁可漏报、不误报）。',
  ].join('\n');
}

// Heuristic: does this rule's checklist concern character/setting consistency? Interim
// gate so the canon-truth policy is injected ONLY for consistency rules (de-hardwired
// from the global template) — until rules carry an authored kind via the LLM rule-
// enhancement spec (see shadow/DESIGN.md §6/④).
const CONSISTENCY_RE = /设定|人物|角色|性格|言行|动机|价值观|形象|一致|前后矛盾|矛盾/;
function isConsistencyAssertions(assertions: string[]): boolean {
  return assertions.some((a) => CONSISTENCY_RE.test(a));
}

// Canon-truth policy (shadow/DESIGN.md): canon = authored truth; the ONLY sanctioned way
// prose may diverge is an element_patch that is IN EFFECT for this chapter (the judge's
// get_element_patches is timeline-filtered to ≤N). No in-effect patch → report. The
// in-prose narrative framing (arc, "this time", payoff) does NOT excuse — only an authored
// patch does. This is what kills the judge's "it's an intentional arc" rationalization
// (the exact false-negative we hit: 米拉 cried vs 从不哭, no patch, yet passed).
const CANON_TRUTH_POLICY = [
  '【设定一致性·canon 政策】本类约束按下面规则裁决，不要替作者圆场：',
  '· canon(角色/设定的 简介/正文/字段)是作者敲定的真理。正文与之冲突时，唯一合法的例外是：该设定有一条【对本章已生效】的演化记录(patch)解释了这个变化。',
  '· 一旦发现某角色言行与其设定冲突，必须 get_element_patches 查它的演化记录(该工具只会返回对本章已生效的 patch)：有 patch 解释→判一致；没有→报出(advisory)，交作者裁定(改正文/更新设定/有意为之)。',
  '· 正文内部的叙事铺垫(退化弧、「这一次」、伏笔回收)不构成例外——只有作者写下的 patch 才算。绝不要因为「正文自己解释了」就放过无 patch 背书的冲突。',
  '· 「从不/总是/绝不/永远/只」这类绝对设定被正文打破、且无已生效 patch → 必报。',
  '· 区分叙述确立的事实 vs 角色口中的话：角色撒谎/自夸不是 canon 冲突。',
].join('\n');

// The judge's anchored header: WHO it's reviewing (chapter identity), that it
// already HOLDS the full prose (so it stops re-searching the project for its own
// text), and cheap warm-start hints. This is the fix for the "未知章节 / 满世界
//找自己正文" flailing — without it the judge has no name to address its own node.
function buildChapterHeader(context: SemanticEvalContext | undefined, blockCount: number): string {
  // Summaries are warm-start hints (just enough to decide whether to fetch full);
  // keep them short so the seed stays lean.
  const clip = (s: string) => (s.length > 100 ? `${s.slice(0, 100)}…` : s);
  const lines: string[] = [];
  const id = context?.identity;
  if (id?.title) {
    const kindLabel = id.kind === 'drift' ? 'drift 节点' : '章节';
    // Note the total chapter count only — NOT this chapter's index, which nudged
    // the model to go read neighbouring chapters it didn't need.
    const pos = id.position ? `（${id.position}）` : '';
    lines.push(`你正在审${kindLabel}《${id.title}》${pos}。`);
  }
  lines.push(
    `下面「正文」就是这一章的完整正文（共 ${blockCount} 段），你已拿到全文——不要再去检索或定位本章自身的内容。`,
  );
  // Each warm-start entry is tagged with its KIND so the judge knows the right
  // read_node(kind=…) to use and doesn't mistake an element for a chapter.
  const scene = (context?.sceneEntities ?? []).filter((e) => e.name?.trim());
  if (scene.length) {
    lines.push(
      `本章登场的元素（扫描正文得到，可能不全；读全文用 read_node(kind='element')）：\n${scene
        .map((e) => `- [element] ${e.name}${e.summary ? `：${clip(e.summary)}` : ''}`)
        .join('\n')}`,
    );
  }
  const prior = context?.priorChapter;
  if (prior?.title) {
    lines.push(
      `前一章（连续性核对用 read_node(kind='chapter') 索取全文）：\n- [chapter] ${prior.title}${prior.summary ? `：${clip(prior.summary)}` : ''}`,
    );
  }
  const drifts = (context?.driftNodes ?? []).filter((d) => d.title?.trim());
  if (drifts.length) {
    lines.push(
      `可能相关的设定 drift（先看 summary，相关再用 read_node(kind='drift') 索取全文）：\n${drifts
        .map((d) => `- [drift] ${d.title}${d.summary ? `：${clip(d.summary)}` : ''}`)
        .join('\n')}`,
    );
  }
  return lines.join('\n');
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
  calls?: ShadowToolCall[];
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
// gets the project's READ tools (read_element, search_prose, read_node,
// …) and calls whatever it needs, in any order, with free arguments — then calls
// the terminal `submit_verdicts` tool to rule. We (the harness) execute each tool,
// thread results back as tool messages, and enforce guardrails: a hard cap on
// tool calls, a round cap, result truncation, and a forced submit at the end.
// Strictly READ tools (caller passes a read-only set) keeps advise-not-block.
//
// The judge takes ALL of one rule's semantic assertions at once and rules on them
// in a SINGLE loop — these checks share context by design (a rule groups related
// concerns: 分幕→每幕POV→禁止头跳 all consume the same act segmentation), so the
// shared canon + reasoning is gathered once instead of re-fetched per assertion.
// Verdicts stay per-assertion (no cross-rule contamination — different rules run
// in different loops). See evaluateRules: only items within one rule batch here.

// Evidence + turn budgets SCALE with how many assertions the rule batches —
// judging 3 related checks legitimately needs more canon than judging 1. With the
// scope-discipline + anti-hallucination fixes each round is productive, so a
// roomier ceiling buys real investigation instead of flailing. (base + per·count)
const FC_TOOL_CALLS_BASE = 12; // evidence fetches floor
const FC_TOOL_CALLS_PER_ASSERTION = 6; // + per batched check
const FC_ROUNDS_BASE = 12; // model-turn floor
const FC_ROUNDS_PER_ASSERTION = 5; // + per batched check
const FC_MODEL = 'gemini-3.5-flash'; // non-deepseek id ⇒ provider substitutes its configured default
// Per-tool-result cap fed back to the model. read_node returns a FULL chapter
// (the judge's main reason to fetch — continuity), so this must be roomy: 2000
// chopped a 6770-word chapter to ~a quarter. A few full reads still fit DeepSeek's
// window; the round/tool-call caps bound how many. The trace keeps a shorter slice
// (panel display only — full content is in the ai-log) to bound the stored row.
const FC_RESULT_MAX = 16000; // chars per tool result fed back to the model
const FC_TRACE_RESULT_MAX = 2000; // chars per tool result KEPT in the trace (panel display)

const SUBMIT_VERDICTS_TOOL: AITool = {
  name: 'submit_verdicts',
  description:
    '证据已足够，一次性提交对所有约束的最终裁决。verdicts 必须每条约束恰好一项，用 constraint 标明约束编号（与输入的「约束」列表 1-based 对应）。每项都必须填 basis（核对依据，即使判一致也要写）。某条整章满足时其 violations 为空数组；不确定/依据不足的边缘段不写进 violations，但仍要在 basis 说明。',
  parametersSchema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        description: '每条约束一项的裁决列表',
        items: {
          type: 'object',
          properties: {
            constraint: { type: 'number', description: '约束编号(1 起，对应输入「约束」的顺序)' },
            basis: {
              type: 'string',
              description:
                '核对依据：逐个核对了哪些角色/设定的【当前值】对照本章哪几段，结论一致还是冲突。判一致也必须写，不得为空——这是为了逼出真实比对，杜绝「读完直接空数组、零依据放行」。',
            },
            violations: {
              type: 'array',
              description: '该约束违反的连续段范围列表；无违反则为空数组',
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
          required: ['constraint', 'basis', 'violations'],
        },
      },
    },
    required: ['verdicts'],
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

// Map the batched verdict back to one RawViolation[] per input assertion, keyed by
// the model's 1-based `constraint`. Out-of-range / missing constraints → empty.
function coerceBatchVerdicts(args: unknown, count: number): RawViolation[][] {
  const out: RawViolation[][] = Array.from({ length: count }, () => []);
  const raw = (args as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const idx = Math.floor(Number(o.constraint ?? 0)) - 1; // 1-based → 0-based
    if (idx < 0 || idx >= count) continue;
    out[idx] = coerceVerdict(o); // reads o.violations
  }
  return out;
}

// The per-constraint `basis` (the forced check rationale) keyed by 1-based constraint
// → surfaced in the trace so even a PASS shows WHAT the judge actually compared.
function coerceBases(args: unknown, count: number): string[] {
  const out: string[] = Array.from({ length: count }, () => '');
  const raw = (args as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const idx = Math.floor(Number(o.constraint ?? 0)) - 1;
    if (idx < 0 || idx >= count) continue;
    out[idx] = String(o.basis ?? '').trim();
  }
  return out;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const vals = Object.values(args as Record<string, unknown>)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v));
  return vals.join(' ');
}

// Judge a rule's semantic assertions together. Returns one SemanticViolation[]
// per input assertion (aligned by index). The whole rule shares ONE tool loop.
export async function evaluateSemanticAssertionsFC(
  assertions: string[],
  blocks: { id: string | null; text: string }[],
  projectId: string,
  context: SemanticEvalContext | undefined,
  client: LLMClient,
  readTools: AITool[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolRunOutcome>,
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
  // Per-call usage bypass (like onTrace) — lets the eval attribute tokens/cost down
  // to a single judge invocation without changing the return shape. Unused in prod.
  onUsage?: (usage: AIUsage) => void,
  // The judge model. Prod passes the user's Shadow tier model (设置 · Shadow);
  // omitted by the eval, which leaves the non-deepseek placeholder so the provider
  // substitutes its configured defaultModel (the eval flips the model that way).
  judgeModel: string = FC_MODEL,
): Promise<SemanticViolation[][]> {
  const active = assertions.map((a) => a.trim());
  const empty = (): SemanticViolation[][] => assertions.map(() => []);
  if (active.every((a) => !a) || blocks.length === 0) return empty();

  const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
  const outputLanguage = resolveWritingLanguage(projectId);
  const tools = [...readTools, SUBMIT_VERDICTS_TOOL];
  const constraintList = active.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const multi = active.length > 1;

  const system = [
    `你是小说写作 CI 的取证式审阅器。给你一章正文(按段编号)和 ${active.length} 条「约束」，请逐条裁决。`,
    multi
      ? '这些约束往往共享同一批设定/上下文(同一批角色、同一段剧情)，请一次把需要的设定查清、复用证据，再逐条判——不要为每条约束重复取证。'
      : '',
    // Scope discipline — the judge was over-fetching: re-reading its own prose and
    // pulling whole prior chapters for structural rules that only concern this text.
    '默认只依据下面的「正文」判断。本章全文已在上文按段给你——绝不要再去读/检索本章自身。',
    '结构/格式类约束(是否分幕、单一视角、是否头跳、字数等)只看本章正文即可，不要读其他章节或设定。仅当约束确实涉及跨章连续性或人物动机/设定一致性时，才去取证。',
    // Tool-shape guidance — it kept hallucinating read_drift / search_facts / get_all_drifts.
    '只读工具就是给你的这几个，没有别的：读 drift/设定/元素/故事线的正文一律用 read_node(node=名称, kind=\'drift\'|\'element\'|\'storyline\'|\'category\')；查内容用 search_prose，查名称/元数据用 search_project。不要臆造工具名或给工具加未列出的参数。',
    '克制取证：能直接判就别查；只查真正影响判断的；同一样东西只查一次。',
    // Per-rule judging template: the LLM-authored, author-editable guide for THIS rule
    // (from the enhancement compiler, threaded via context.judgingGuide). It embeds the
    // canon-truth policy for consistency rules. Falls back to the templated canon-truth
    // policy via the heuristic when a rule predates enhancement (legacy/eval). DESIGN.md §6.
    context?.judgingGuide?.trim()
      ? context.judgingGuide.trim()
      : isConsistencyAssertions(active)
        ? CANON_TRUTH_POLICY
        : '',
    '查够了就调用 submit_verdicts 一次性给出每条约束的裁决(每条一项，按约束编号)。',
    '裁决规则:每条约束都必须在 basis 写明核对依据(核对了哪些角色/设定的【当前值】对照本章哪几段→一致还是冲突;判一致也要写,不得空);只把确实违反的连续段写进 violations(blockStart/blockEnd 含两端,整章级用 0),某条整章满足则 violations 为空数组;仍然宁可漏报别误报，但「漏报」只能是「核对后判一致」，不允许「未核对/零依据就空数组」。',
    `用 ${outputLanguage} 写所有自然语言输出(reason 等)。`,
  ]
    .filter(Boolean)
    .join('\n');

  const header = buildChapterHeader(context, blocks.length);
  const depHint = buildChangedDepsHint(context);
  const messages: AIMessage[] = [
    {
      role: 'user',
      content:
        `${header}\n\n背景设定：\n${buildBackground(context)}` +
        (depHint ? `\n\n${depHint}` : '') +
        `\n\n约束（共 ${active.length} 条，逐条裁决）：\n${constraintList}\n\n正文（按段编号）：\n${numbered}`,
    },
  ];

  const count = Math.max(1, active.filter(Boolean).length);
  const maxToolCalls = FC_TOOL_CALLS_BASE + FC_TOOL_CALLS_PER_ASSERTION * count;
  const maxRounds = FC_ROUNDS_BASE + FC_ROUNDS_PER_ASSERTION * count;

  let toolCalls = 0;
  for (let round = 0; round < maxRounds; round++) {
    const force = toolCalls >= maxToolCalls || round === maxRounds - 1;
    const resp = await client.complete({
      model: judgeModel,
      system,
      messages,
      tools,
      toolChoice: force ? { force: 'submit_verdicts' } : 'auto',
      // Reason during investigation (auto rounds); MUST stay OFF on the forced-
      // submit round — forced tool_choice + thinking = 400 on DeepSeek (deepseek.ts).
      thinking: !force,
      signal,
      metadata: { feature: 'shadow-semantic-fc' },
    });
    if (resp.usage) onUsage?.(resp.usage);

    const calls: AIToolCall[] = resp.toolCalls ?? (resp.toolCall ? [resp.toolCall] : []);
    if (calls.length === 0) {
      // Model answered in prose without calling submit — nudge it to rule.
      messages.push({ role: 'model', content: resp.text ?? '' });
      messages.push({ role: 'user', content: '请调用 submit_verdicts 一次性提交每条约束的裁决。' });
      continue;
    }

    messages.push({ role: 'model', content: resp.text ?? '', toolCalls: calls });

    const traceCalls: ShadowToolCall[] = [];
    let submitted: SemanticViolation[][] | null = null;
    let bases: string[] = [];
    for (const call of calls) {
      if (call.name === 'submit_verdicts') {
        submitted = coerceBatchVerdicts(call.arguments, active.length).map((vs) =>
          mapViolations(vs, blocks),
        );
        bases = coerceBases(call.arguments, active.length);
        continue;
      }
      toolCalls += 1;
      const argRecord =
        call.arguments && typeof call.arguments === 'object'
          ? (call.arguments as Record<string, unknown>)
          : {};
      let outcome: ToolRunOutcome;
      try {
        outcome = await runTool(call.name, argRecord);
      } catch (e) {
        // A cancel must unwind the whole review, not be swallowed as a tool error.
        if (e instanceof Error && e.name === 'ShadowCancelledError') throw e;
        const msg = e instanceof Error ? e.message : String(e);
        outcome = { content: `（工具错误：${msg}）`, status: 'error', note: msg };
      }
      const forModel =
        outcome.content.length > FC_RESULT_MAX
          ? `${outcome.content.slice(0, FC_RESULT_MAX)}…（截断）`
          : outcome.content;
      messages.push({ role: 'tool', toolCallId: call.id, content: forModel });
      traceCalls.push({
        tool: call.name,
        args: summarizeArgs(call.arguments) || undefined,
        status: outcome.status,
        note: outcome.note,
        // Keep the result the model saw (trace-capped) so the panel can show it.
        result:
          forModel.length > FC_TRACE_RESULT_MAX
            ? `${forModel.slice(0, FC_TRACE_RESULT_MAX)}…（截断）`
            : forModel,
      });
    }
    if (traceCalls.length) {
      const bad = traceCalls.filter((c) => c.status !== 'ok').length;
      onTrace?.({
        label: bad ? `查证 · 第 ${round + 1} 轮（${bad} 失败）` : `查证 · 第 ${round + 1} 轮`,
        calls: traceCalls,
      });
    }
    if (submitted) {
      const hit = submitted.filter((vs) => vs.length > 0).length;
      const reasons = submitted.flat().map((v) => v.reason).filter(Boolean);
      // On a PASS, show the forced `basis` (what the judge actually compared) so a
      // silent rubber-stamp is no longer possible to hide — the panel sees the check.
      const checkNotes = bases.filter(Boolean);
      onTrace?.({
        label: hit ? `裁决：${hit}/${active.length} 条发现违反` : `裁决：${active.length} 条全部通过`,
        items: reasons.length ? reasons : checkNotes.length ? checkNotes : undefined,
      });
      return submitted;
    }
    await yieldToMain(); // let this round's trace-push re-render + paint before the next
  }
  return empty();
}
