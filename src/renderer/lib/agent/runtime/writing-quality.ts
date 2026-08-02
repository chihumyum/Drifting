import type { AgentRuntimeTaskStepReviewResult } from '../../../domain/agent-runtime-long-task';
import { analyzeAgentLiteraryStyle, type AgentLiteraryStyleProfile } from './writing-intelligence';

export interface AgentVoiceContinuityScore {
  score: number;
  components: {
    paragraphCadence: number;
    sentenceCadence: number;
    dialogue: number;
    punctuationDensity: number;
    person: number;
    punctuationSignature: number;
    functionWordSignature: number;
  };
  reference: AgentLiteraryStyleProfile;
  candidate: AgentLiteraryStyleProfile;
}

export interface AgentSemanticCitationValidation {
  valid: boolean;
  citationCount: number;
  citedItemCount: number;
  itemCount: number;
  coverage: number;
  missingQuotes: string[];
}

const PUNCTUATION_SIGNATURE = ['，', '。', '！', '？', '；', '：', '—', '…', '、'] as const;
const FUNCTION_WORD_SIGNATURE = [
  '却',
  '只是',
  '仿佛',
  '似乎',
  '仍',
  '便',
  '于是',
  '而',
  '但',
  '的',
  '了',
  '着',
  '我',
  '她',
  '他',
  '他们',
] as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function relativeSimilarity(left: number, right: number, floor: number): number {
  return clamp01(1 - Math.abs(left - right) / Math.max(floor, Math.abs(left), Math.abs(right)));
}

function countOccurrences(source: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= source.length - needle.length) {
    const next = source.indexOf(needle, cursor);
    if (next < 0) break;
    count += 1;
    cursor = next + needle.length;
  }
  return count;
}

function signature(source: string, needles: readonly string[]): number[] {
  const chars = Math.max(1, [...source.replace(/\s/gu, '')].length);
  return needles.map((needle) => countOccurrences(source, needle) / chars);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);
  const leftNorm = Math.sqrt(left.reduce((total, value) => total + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((total, value) => total + value * value, 0));
  if (leftNorm === 0 && rightNorm === 0) return 1;
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clamp01(dot / (leftNorm * rightNorm));
}

/**
 * Diagnostic, provider-neutral voice comparison. It is intentionally not an
 * autonomous acceptance gate: exact nearby prose remains the primary witness.
 */
export function scoreAgentVoiceContinuity(
  referenceParagraphs: readonly string[],
  candidateParagraphs: readonly string[],
): AgentVoiceContinuityScore | null {
  const reference = analyzeAgentLiteraryStyle(referenceParagraphs);
  const candidate = analyzeAgentLiteraryStyle(candidateParagraphs);
  if (!reference || !candidate) return null;
  const referenceText = referenceParagraphs.join('\n');
  const candidateText = candidateParagraphs.join('\n');
  const components = {
    paragraphCadence: relativeSimilarity(
      reference.medianParagraphChars,
      candidate.medianParagraphChars,
      12,
    ),
    sentenceCadence: relativeSimilarity(
      reference.averageSentenceChars,
      candidate.averageSentenceChars,
      8,
    ),
    dialogue: relativeSimilarity(reference.dialogueRatio, candidate.dialogueRatio, 0.08),
    punctuationDensity: relativeSimilarity(
      reference.punctuationDensity,
      candidate.punctuationDensity,
      0.03,
    ),
    person: relativeSimilarity(reference.firstPersonDensity, candidate.firstPersonDensity, 0.01),
    punctuationSignature: cosine(
      signature(referenceText, PUNCTUATION_SIGNATURE),
      signature(candidateText, PUNCTUATION_SIGNATURE),
    ),
    functionWordSignature: cosine(
      signature(referenceText, FUNCTION_WORD_SIGNATURE),
      signature(candidateText, FUNCTION_WORD_SIGNATURE),
    ),
  };
  const score =
    components.paragraphCadence * 0.16 +
    components.sentenceCadence * 0.2 +
    components.dialogue * 0.12 +
    components.punctuationDensity * 0.12 +
    components.person * 0.08 +
    components.punctuationSignature * 0.16 +
    components.functionWordSignature * 0.16;
  return {
    score: rounded(score),
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, rounded(value)]),
    ) as AgentVoiceContinuityScore['components'],
    reference,
    candidate,
  };
}

/** Exact-citation oracle shared by headless literary QA evaluation. */
export function validateAgentSemanticCitations(
  result: AgentRuntimeTaskStepReviewResult,
  sourcePassages: readonly string[],
): AgentSemanticCitationValidation {
  const items = [...result.claims, ...result.findings];
  const citations = items.flatMap((item) => item.citations);
  const missingQuotes = [
    ...new Set(
      citations
        .filter((citation) => !sourcePassages.some((source) => source.includes(citation.quote)))
        .map((citation) => citation.quote),
    ),
  ];
  const citedItemCount = items.filter((item) => item.citations.length > 0).length;
  return {
    valid:
      items.length > 0 &&
      citedItemCount === items.length &&
      citations.length > 0 &&
      missingQuotes.length === 0,
    citationCount: citations.length,
    citedItemCount,
    itemCount: items.length,
    coverage: items.length === 0 ? 0 : rounded(citedItemCount / items.length),
    missingQuotes,
  };
}
