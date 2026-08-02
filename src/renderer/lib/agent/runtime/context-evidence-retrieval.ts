export type AgentContextEvidenceFieldKind =
  | 'title'
  | 'alias'
  | 'summary'
  | 'fact'
  | 'prose';

export interface AgentContextEvidenceField {
  kind: AgentContextEvidenceFieldKind;
  text: string;
  /** One-based prose block when the field came from a block document. */
  block?: number;
}

export interface AgentContextEvidenceDocument {
  evidenceId: string;
  kind: string;
  title: string;
  path?: string;
  updatedAt?: string | null;
  /** Current domain/Yjs revision returned to the model for provenance. */
  revision?: string | null;
  /** Stable reading/domain order used only after relevance and freshness tie. */
  ordinal?: number;
  fields: readonly AgentContextEvidenceField[];
}

export interface AgentContextEvidenceMatch {
  evidenceId: string;
  kind: string;
  title: string;
  path?: string;
  score: number;
  matchedTerms: string[];
  matchedField: AgentContextEvidenceFieldKind;
  block?: number;
  snippet: string;
  freshness: {
    updatedAt: string | null;
    revision: string | null;
  };
}

export interface RankAgentContextEvidenceInput {
  query: string;
  documents: readonly AgentContextEvidenceDocument[];
  limit?: number;
  pathPrefix?: string;
}

const FIELD_WEIGHT: Record<AgentContextEvidenceFieldKind, number> = {
  title: 8,
  alias: 7,
  summary: 4,
  fact: 5,
  prose: 1,
};
const MAX_LIMIT = 100;
const SNIPPET_RADIUS = 120;

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function cjkTerms(sequence: string): string[] {
  const points = [...sequence];
  if (points.length <= 1) return points;
  const terms = [sequence];
  for (let index = 0; index < points.length - 1; index += 1) {
    terms.push(`${points[index]}${points[index + 1]}`);
  }
  return terms;
}

/** Provider-free lexical terms suitable for mixed Chinese/Latin novel text. */
export function tokenizeAgentContextEvidenceQuery(query: string): string[] {
  const normalized = normalize(query);
  const terms: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Letter}\p{Number}_-]+/gu)) {
    const token = match[0];
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(token)) {
      terms.push(...cjkTerms(token));
    } else if (token.length > 1 || /\p{Number}/u.test(token)) {
      terms.push(token);
    }
  }
  return [...new Set(terms)].slice(0, 64);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snippet(text: string, normalizedText: string, needles: readonly string[]): string {
  let position = Number.MAX_SAFE_INTEGER;
  for (const needle of needles) {
    const found = normalizedText.indexOf(needle);
    if (found >= 0) position = Math.min(position, found);
  }
  if (position === Number.MAX_SAFE_INTEGER) position = 0;
  const codePoints = [...text];
  // JS string indexes and code-point indexes differ around emoji. The prefix
  // conversion keeps the returned excerpt Unicode-safe while preserving text.
  const pointOffset = [...text.slice(0, position)].length;
  const start = Math.max(0, pointOffset - SNIPPET_RADIUS);
  const end = Math.min(codePoints.length, pointOffset + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${codePoints.slice(start, end).join('')}${
    end < codePoints.length ? '…' : ''
  }`;
}

/**
 * Deterministic BM25-like evidence ranking with a deliberately small freshness
 * tie-breaker. A recently touched distractor cannot outrank an older canon row
 * that covers more query terms, but equally relevant current evidence wins.
 */
export function rankAgentContextEvidence(
  input: RankAgentContextEvidenceInput,
): AgentContextEvidenceMatch[] {
  const phrase = normalize(input.query.trim());
  if (!phrase) return [];
  const terms = tokenizeAgentContextEvidenceQuery(phrase);
  if (terms.length === 0) return [];
  const limit = Math.min(Math.max(input.limit ?? 30, 1), MAX_LIMIT);
  const documents = input.documents.filter(
    (document) =>
      !input.pathPrefix ||
      document.path === input.pathPrefix ||
      document.path?.startsWith(`${input.pathPrefix.replace(/\/$/u, '')}/`),
  );
  const normalizedFields = documents.map((document) => ({
    document,
    fields: document.fields.map((field) => ({
      field,
      normalized: normalize(field.text),
    })),
  }));
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      normalizedFields.filter(({ fields }) =>
        fields.some(({ normalized: value }) => value.includes(term)),
      ).length,
    );
  }
  const times = documents
    .map((document) => timestamp(document.updatedAt))
    .filter((value): value is number => value !== null);
  const newest = times.length > 0 ? Math.max(...times) : null;
  const oldest = times.length > 0 ? Math.min(...times) : null;

  const matches: Array<AgentContextEvidenceMatch & { ordinal: number }> = [];
  for (const { document, fields } of normalizedFields) {
    const matchedTerms = terms.filter((term) =>
      fields.some(({ normalized: value }) => value.includes(term)),
    );
    if (matchedTerms.length === 0) continue;
    let score = (matchedTerms.length / terms.length) * 80;
    let best:
      | { field: AgentContextEvidenceField; normalized: string; score: number }
      | undefined;
    for (const candidate of fields) {
      let fieldScore = 0;
      const weight = FIELD_WEIGHT[candidate.field.kind];
      if (candidate.normalized.includes(phrase)) fieldScore += 60 * weight;
      for (const term of matchedTerms) {
        const frequency = occurrences(candidate.normalized, term);
        if (frequency === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        fieldScore += weight * idf * (1 + Math.log(frequency));
      }
      score += fieldScore;
      if (!best || fieldScore > best.score) best = { ...candidate, score: fieldScore };
    }
    if (!best) continue;
    const updatedAt = timestamp(document.updatedAt);
    if (updatedAt !== null && newest !== null && oldest !== null) {
      score += newest === oldest ? 4 : ((updatedAt - oldest) / (newest - oldest)) * 8;
    }
    matches.push({
      evidenceId: document.evidenceId,
      kind: document.kind,
      title: document.title,
      ...(document.path ? { path: document.path } : {}),
      score: Number(score.toFixed(6)),
      matchedTerms,
      matchedField: best.field.kind,
      ...(best.field.block ? { block: best.field.block } : {}),
      snippet: snippet(best.field.text, best.normalized, matchedTerms),
      freshness: {
        updatedAt: document.updatedAt ?? null,
        revision: document.revision ?? document.updatedAt ?? null,
      },
      ordinal: document.ordinal ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.matchedTerms.length - left.matchedTerms.length ||
        left.ordinal - right.ordinal ||
        left.evidenceId.localeCompare(right.evidenceId, 'en'),
    )
    .slice(0, limit)
    .map(({ ordinal: _ordinal, ...match }) => match);
}
