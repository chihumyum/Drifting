import {
  AGENT_WORKING_MEMORY_HARD_TOKENS,
  AGENT_WORKING_MEMORY_MAX_CHARACTERS,
  AGENT_WORKING_MEMORY_SOFT_TOKENS,
  AGENT_WORKING_MEMORY_TARGET_TOKENS,
} from '../../../domain/agent-working-memory';
import { estimateAgentContextTextTokens } from './context-planner';

const RECENT_HEADING = /^##\s+Recent\s*$/imu;
const SECOND_LEVEL_HEADING = /^##\s+/gmu;
const ENTRY_HEADING = /^###\s+.+$/gmu;
const BULLET_ENTRY = /^[-*+]\s+\S.*$/gmu;
const EARLIER_SUMMARY_HEADING = /^##\s+Earlier summary\s*$/imu;
const MIN_EXACT_RECENT_ENTRIES = 2;

export interface AgentWorkingMemoryCompactionResult {
  contentMd: string;
  approxTokens: number;
  compacted: boolean;
  retiredEntries: number;
}

export function normalizeAgentWorkingMemoryMarkdown(value: string): string {
  const normalized = value.replaceAll('\u0000', '').replace(/\r\n?/gu, '\n').trim();
  if (normalized.length > AGENT_WORKING_MEMORY_MAX_CHARACTERS) {
    throw new Error(`Working Memory exceeds ${AGENT_WORKING_MEMORY_MAX_CHARACTERS} characters.`);
  }
  return normalized ? `${normalized}\n` : '';
}

function sectionRange(content: string, heading: RegExp): { start: number; end: number } | null {
  const match = heading.exec(content);
  if (!match || match.index === undefined) return null;
  const afterHeading = match.index + match[0].length;
  SECOND_LEVEL_HEADING.lastIndex = afterHeading;
  const next = SECOND_LEVEL_HEADING.exec(content);
  SECOND_LEVEL_HEADING.lastIndex = 0;
  return { start: match.index, end: next?.index ?? content.length };
}

function removeRange(content: string, range: { start: number; end: number }): string {
  return `${content.slice(0, range.start).trimEnd()}\n\n${content.slice(range.end).trimStart()}`.trim();
}

function recentEntryRanges(content: string): Array<{ start: number; end: number }> {
  const section = sectionRange(content, RECENT_HEADING);
  if (!section) return [];
  const body = content.slice(section.start, section.end);
  const headingStarts = [...body.matchAll(ENTRY_HEADING)].map(
    (match) => section.start + match.index!,
  );
  const starts = headingStarts.length
    ? headingStarts
    : [...body.matchAll(BULLET_ENTRY)].map((match) => section.start + match.index!);
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? section.end,
  }));
}

/**
 * Bounded deterministic fallback for the rolling Markdown document.
 *
 * The Agent is asked to summarize old work while it still has semantic
 * context. If that checkpoint remains over the soft budget, this fallback
 * removes the oldest completed `## Recent` entries (the list is newest first) while
 * preserving `## Current` and at least the two newest exact entries. An older
 * lossy summary is retired first because it represents the earliest context.
 */
export function compactAgentWorkingMemoryMarkdown(
  rawContent: string,
): AgentWorkingMemoryCompactionResult {
  let contentMd = normalizeAgentWorkingMemoryMarkdown(rawContent);
  let approxTokens = estimateAgentContextTextTokens(contentMd);
  if (approxTokens <= AGENT_WORKING_MEMORY_SOFT_TOKENS) {
    return { contentMd, approxTokens, compacted: false, retiredEntries: 0 };
  }

  let compacted = false;
  let retiredEntries = 0;
  const earlier = sectionRange(contentMd, EARLIER_SUMMARY_HEADING);
  if (earlier) {
    contentMd = removeRange(contentMd, earlier);
    compacted = true;
    approxTokens = estimateAgentContextTextTokens(contentMd);
  }

  while (approxTokens > AGENT_WORKING_MEMORY_TARGET_TOKENS) {
    const entries = recentEntryRanges(contentMd);
    if (entries.length <= MIN_EXACT_RECENT_ENTRIES) break;
    contentMd = removeRange(contentMd, entries[entries.length - 1]!);
    compacted = true;
    retiredEntries += 1;
    approxTokens = estimateAgentContextTextTokens(contentMd);
  }

  contentMd = normalizeAgentWorkingMemoryMarkdown(contentMd);
  approxTokens = estimateAgentContextTextTokens(contentMd);
  if (approxTokens > AGENT_WORKING_MEMORY_HARD_TOKENS) {
    throw new Error(
      'WORKING_MEMORY_TOO_LARGE: shrink Current or the newest records before saving.',
    );
  }
  return { contentMd, approxTokens, compacted, retiredEntries };
}
