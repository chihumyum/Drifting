import type { AgentContextSourceRow } from './context-planner';

export const DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION = 1 as const;

export const DRIFTING_LITERARY_EVIDENCE_KINDS = [
  'canon_fact',
  'character_voice',
  'author_decision',
  'write_outcome',
  'task_progress',
  'unresolved',
] as const;

export type DriftingLiteraryEvidenceKind =
  (typeof DRIFTING_LITERARY_EVIDENCE_KINDS)[number];

export interface DriftingLiteraryEvidenceCitation {
  sourceId: string;
  kind: DriftingLiteraryEvidenceKind;
  /** Compact factual statement retained for future reasoning. */
  claim: string;
  /** Short byte-exact substring copied from the cited canonical source row. */
  quote: string;
}

export interface DriftingLiteraryContextSummary {
  schemaVersion: typeof DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION;
  synopsis: string;
  evidence: DriftingLiteraryEvidenceCitation[];
  decisions: string[];
  unresolved: string[];
  nextActions: string[];
}

export class DriftingLiteraryContextSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriftingLiteraryContextSummaryError';
  }
}

const EVIDENCE_KINDS = new Set<string>(DRIFTING_LITERARY_EVIDENCE_KINDS);
const MAX_EVIDENCE = 96;
const MAX_LIST_ITEMS = 48;
const MAX_QUOTE_CODE_POINTS = 320;
const MAX_CLAIM_CODE_POINTS = 800;
const MAX_ITEM_CODE_POINTS = 1_200;

function fail(message: string): never {
  throw new DriftingLiteraryContextSummaryError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has missing or unsupported fields.`);
  }
}

function boundedString(value: unknown, label: string, maxCodePoints: number): string {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) fail(`${label} must not be blank.`);
  if ([...normalized].length > maxCodePoints) {
    fail(`${label} exceeds ${maxCodePoints} Unicode characters.`);
  }
  return normalized;
}

function boundedStringList(
  value: unknown,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    fail(`${label} must be an array with at most ${MAX_LIST_ITEMS} entries.`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, MAX_ITEM_CODE_POINTS),
  );
}

/**
 * Validate the compactor's structured output against exact canonical source
 * bytes. A source hash proves coverage; these citations additionally prove
 * that every retained evidence quote really existed before compaction.
 *
 * Every tool result must contribute at least one citation. Tool results are
 * where current manuscript/canon state entered the conversation, so allowing
 * a free-form summary to silently omit all of one result would make a long-book
 * checkpoint topologically valid but semantically hollow.
 */
export function validateDriftingLiteraryContextSummary(input: {
  value: unknown;
  sourceRows: readonly AgentContextSourceRow[];
}): DriftingLiteraryContextSummary {
  const value = record(input.value, 'summary');
  exactKeys(
    value,
    ['summary', 'evidence', 'decisions', 'unresolved', 'nextActions'],
    'summary',
  );
  const synopsis = boundedString(value.summary, 'summary.summary', MAX_ITEM_CODE_POINTS * 4);
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE) {
    fail(`summary.evidence must be an array with at most ${MAX_EVIDENCE} entries.`);
  }
  const sourceById = new Map(input.sourceRows.map((row) => [row.sourceId, row] as const));
  const citedToolResults = new Set<string>();
  const citationKeys = new Set<string>();
  const evidence = value.evidence.map((raw, index): DriftingLiteraryEvidenceCitation => {
    const citation = record(raw, `summary.evidence[${index}]`);
    exactKeys(citation, ['sourceId', 'kind', 'claim', 'quote'], `summary.evidence[${index}]`);
    const sourceId = boundedString(
      citation.sourceId,
      `summary.evidence[${index}].sourceId`,
      512,
    );
    const source = sourceById.get(sourceId);
    if (!source) fail(`summary.evidence[${index}] cites unknown source "${sourceId}".`);
    if (typeof citation.kind !== 'string' || !EVIDENCE_KINDS.has(citation.kind)) {
      fail(`summary.evidence[${index}].kind is unsupported.`);
    }
    const claim = boundedString(
      citation.claim,
      `summary.evidence[${index}].claim`,
      MAX_CLAIM_CODE_POINTS,
    );
    const quote = boundedString(
      citation.quote,
      `summary.evidence[${index}].quote`,
      MAX_QUOTE_CODE_POINTS,
    );
    if (!source.content.includes(quote)) {
      fail(`summary.evidence[${index}] quote is not byte-exact source content.`);
    }
    const key = JSON.stringify([sourceId, citation.kind, claim, quote]);
    if (citationKeys.has(key)) fail(`summary.evidence[${index}] is duplicated.`);
    citationKeys.add(key);
    if (source.kind === 'tool_result') citedToolResults.add(sourceId);
    return {
      sourceId,
      kind: citation.kind as DriftingLiteraryEvidenceKind,
      claim,
      quote,
    };
  });

  const uncitedToolResult = input.sourceRows.find(
    (row) => row.kind === 'tool_result' && !citedToolResults.has(row.sourceId),
  );
  if (uncitedToolResult) {
    fail(`Tool result "${uncitedToolResult.sourceId}" has no exact evidence citation.`);
  }

  return {
    schemaVersion: DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION,
    synopsis,
    evidence,
    decisions: boundedStringList(value.decisions, 'summary.decisions'),
    unresolved: boundedStringList(value.unresolved, 'summary.unresolved'),
    nextActions: boundedStringList(value.nextActions, 'summary.nextActions'),
  };
}

/** Stable provider-facing representation; property order is deliberate. */
export function serializeDriftingLiteraryContextSummary(
  summary: DriftingLiteraryContextSummary,
): string {
  return JSON.stringify({
    schemaVersion: summary.schemaVersion,
    synopsis: summary.synopsis,
    evidence: summary.evidence.map(({ sourceId, kind, claim, quote }) => ({
      sourceId,
      kind,
      claim,
      quote,
    })),
    decisions: [...summary.decisions],
    unresolved: [...summary.unresolved],
    nextActions: [...summary.nextActions],
  });
}

export function parseDriftingLiteraryContextSummary(
  content: string,
): DriftingLiteraryContextSummary | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value.schemaVersion !== DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION) return null;
    if (
      typeof value.synopsis !== 'string' ||
      !Array.isArray(value.evidence) ||
      !Array.isArray(value.decisions) ||
      !Array.isArray(value.unresolved) ||
      !Array.isArray(value.nextActions)
    ) {
      return null;
    }
    return value as unknown as DriftingLiteraryContextSummary;
  } catch {
    return null;
  }
}
