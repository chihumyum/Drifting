import type { AgentStartInput, AgentStartRoute } from '../protocol';

export const DRIFTING_AGENT_PROMPT_VERSION = 1 as const;

function clean(value: string, maxLength: number): string {
  const normalized = value.split('\u0000').join('').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

/** Deterministic, provider-neutral Drifting policy/context prompt. */
export function buildDriftingAgentSystemPrompt(
  input: AgentStartInput,
  route: AgentStartRoute,
): string {
  const lines = [
    'You are the General Agent inside Drifting, a structured creative-writing workspace.',
    `Your scope is only project "${route.projectId}" on the "${route.kind}" route.`,
    'Use only the provided Drifting tools. Never assume that entities are filesystem files.',
    'All reads and writes must go through those tools so they share renderer use cases, live Yjs prose, sync, checkpoints, and edit review with manual edits.',
    'For prose, prefer stable block-addressed operations. Treat tool results as the current truth.',
    'Every successful read returns { result, freshness }. Use result as the tool payload; preserve freshness citations exactly for any dependent write.',
    'Before rename_node or set_node_summary, call read_node for that exact node, then copy freshness.receiptId plus the matching observation id/revision into expectedRevision. Never invent, reuse across nodes, or strip this freshness citation.',
    'Before create_element_patch or update_element_patch, call get_element_patches for that exact element. For create, cite the element_patch_set observation; for update, cite the matching element_patch observation.',
    'Canon is authored truth. When prose needs to evolve established canon, use the sanctioned patch/evolution tools instead of silently contradicting it.',
    'Use ask_user only when progress is blocked by a real author choice. Ask one focused question at a time; do not ask for facts available through Drifting read tools.',
  ];

  if (route.kind === 'goal' && route.chapterId) {
    lines.push(`This goal turn is scoped to chapter "${route.chapterId}".`);
  }
  const language = input.writingLanguage
    ? clean(input.writingLanguage, 100)
    : '';
  if (language) {
    lines.push(`Write manuscript-facing content in: ${language}.`);
  }

  const facts = (input.projectFacts ?? [])
    .slice(0, 32)
    .map(({ key, value }) => {
      const cleanKey = clean(key, 200);
      const cleanValue = clean(value, 1_000);
      return cleanKey && cleanValue ? `- ${cleanKey}: ${cleanValue}` : '';
    })
    .filter(Boolean);
  if (facts.length > 0) {
    lines.push('Project facts and writing constraints:', ...facts);
  }

  const memories = (input.memories ?? [])
    .slice(0, 64)
    .map(({ kind, body }) => {
      const cleanKind = clean(kind, 100) || 'guidance';
      const cleanBody = clean(body, 2_000);
      return cleanBody ? `- [${cleanKind}] ${cleanBody}` : '';
    })
    .filter(Boolean);
  if (memories.length > 0) {
    lines.push('Author-approved standing guidance:', ...memories);
  }

  return lines.join('\n');
}
