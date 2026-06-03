import { buildDefaultLLMClient } from './client/build-default-client';
import { callStructured } from './call-structured';
import { resolveWritingLanguage } from './output-language';
import { shadowRuleCompilePrompt } from './prompts/templates/shadow-rule-compile';
import { shadowSemanticEvalPrompt } from './prompts/templates/shadow-semantic-eval';
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
  return out.violations
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
