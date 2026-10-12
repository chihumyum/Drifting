import {
  AGENT_WORKING_MEMORY_NOTICE_TOKENS,
  AGENT_WORKING_MEMORY_PERSISTENT_NOTICE_TOKENS,
} from '../../../domain/agent-working-memory';
import { estimateAgentContextTextTokens } from './context-planner';

export interface AgentWorkingMemoryMeasurement {
  contentMd: string;
  approxTokens: number;
}

export function normalizeAgentWorkingMemoryMarkdown(value: string): string {
  const normalized = value.replaceAll('\u0000', '').replace(/\r\n?/gu, '\n').trim();
  return normalized ? `${normalized}\n` : '';
}

/** Normalize and measure a replacement document. There is no size ceiling. */
export function measureAgentWorkingMemoryMarkdown(
  rawContent: string,
): AgentWorkingMemoryMeasurement {
  const contentMd = normalizeAgentWorkingMemoryMarkdown(rawContent);
  return { contentMd, approxTokens: estimateAgentContextTextTokens(contentMd) };
}

export interface AgentWorkingMemoryEdit {
  oldText: string;
  newText: string;
}

/**
 * Apply exact passage replacements in order. Each `oldText` must occur
 * exactly once in the document as it stands after the previous edits, so a
 * large document can be consolidated without rewriting it whole.
 */
export function applyAgentWorkingMemoryEdits(
  contentMd: string,
  edits: readonly AgentWorkingMemoryEdit[],
): string {
  let next = contentMd;
  edits.forEach(({ oldText, newText }, index) => {
    const first = next.indexOf(oldText);
    if (!oldText || first < 0) {
      throw new Error(
        `WORKING_MEMORY_EDIT_NOT_FOUND: edit ${index + 1} oldText does not occur in the current document; read it again.`,
      );
    }
    if (next.indexOf(oldText, first + 1) >= 0) {
      throw new Error(
        `WORKING_MEMORY_EDIT_AMBIGUOUS: edit ${index + 1} oldText occurs more than once; include more surrounding text.`,
      );
    }
    next = `${next.slice(0, first)}${newText}${next.slice(first + oldText.length)}`;
  });
  return next;
}

/** How many notice sizes the document exceeds (0 to 3; 3 is persistent). */
export function agentWorkingMemoryNoticeTier(approxTokens: number): number {
  if (approxTokens > AGENT_WORKING_MEMORY_PERSISTENT_NOTICE_TOKENS) {
    return AGENT_WORKING_MEMORY_NOTICE_TOKENS.length + 1;
  }
  return AGENT_WORKING_MEMORY_NOTICE_TOKENS.filter((size) => approxTokens > size).length;
}

/**
 * Prompt once when the document crosses into a higher notice tier, and on
 * every turn above the persistent size. Shrinking lowers the remembered tier
 * so growing past the same size again prompts again.
 */
export function decideAgentWorkingMemoryNotice(
  approxTokens: number,
  notifiedTier: number,
): { notice: boolean; notifiedTier: number } {
  const tier = agentWorkingMemoryNoticeTier(approxTokens);
  if (tier > AGENT_WORKING_MEMORY_NOTICE_TOKENS.length) return { notice: true, notifiedTier: tier };
  if (tier > notifiedTier) return { notice: true, notifiedTier: tier };
  return { notice: false, notifiedTier: Math.min(notifiedTier, tier) };
}
