import { buildDefaultLLMClient } from './client/build-default-client';
import { callStructured } from './call-structured';
import { resolveWritingLanguage } from './output-language';
import { shadowRuleCompilePrompt } from './prompts/templates/shadow-rule-compile';
import { shadowSemanticEvalPrompt } from './prompts/templates/shadow-semantic-eval';
import { shadowSemanticAgenticPrompt } from './prompts/templates/shadow-semantic-agentic';
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
