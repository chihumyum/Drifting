/**
 * Adaptive chapter context. The principle (per product direction): when a
 * chapter's prose is SMALL, feed the WHOLE chapter as context — faithful, no
 * lossy summary; when it's TOO LARGE, fall back to the rolling block-section
 * summaries. Rolling summaries stay the default ONLY for element extraction /
 * patch (their prompts want the long arc); summary-generation and inline
 * edit/ask prefer the real prose when it fits.
 *
 * Inline edit/ask express "whole chapter" by simply WIDENING their context
 * window to every block (see buildInlineCopilotCtx) — no new field needed, the
 * server prompts already consume contextBefore/contextAfter. Only chapter-
 * summary, which had no full-text input, uses {@link buildAdaptiveChapterContext}
 * to pick fullChapterText vs. sectionSummaries.
 */
import { getChapterContentJson } from '../agent/chapter-prose';
import { useDataStore } from '../../store/data-store';

// Below this many characters we send the whole chapter; above it we summarize.
// Conservative: a typical web-novel chapter (2–4k CJK chars) sends in full;
// only an unusually long chapter falls back to rolling summaries.
export const FULL_CHAPTER_CHAR_BUDGET = 12000;

/** Extract plain text from a ProseMirror contentJson string — block text joined
 *  by blank lines, mirroring how buildInlineCopilotCtx assembles block text. */
export function pmJsonToPlainText(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return '';
  }
  const collect = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const rec = node as { text?: unknown; content?: unknown };
    if (typeof rec.text === 'string') return rec.text;
    if (Array.isArray(rec.content)) return rec.content.map(collect).join('');
    return '';
  };
  const top = (parsed as { content?: unknown })?.content;
  if (!Array.isArray(top)) return '';
  return top
    .map((block) => collect(block).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** A chapter's full prose as plain text, read from the Yjs truth (live doc when
 *  open, else rehydrated), falling back to the node_content seed cache (resolved
 *  inside getChapterContentJson when passed null). */
export async function getChapterPlainText(chapterId: string): Promise<string> {
  const json = await getChapterContentJson(chapterId, null);
  return pmJsonToPlainText(json);
}

export interface AdaptiveChapterContext {
  /** Present when the chapter fits the budget — send this whole. */
  fullChapterText?: string;
  /** Present (fallback) when the chapter is too large — the rolling summaries. */
  sectionSummaries?: string[];
}

/**
 * Decide between full-chapter text and rolling summaries for a chapter, by size.
 * Used by chapter-summary generation (which previously always used the rolling
 * summaries). Returns an empty object when the chapter has neither usable prose
 * nor summaries.
 */
export async function buildAdaptiveChapterContext(
  chapterId: string,
): Promise<AdaptiveChapterContext> {
  const text = await getChapterPlainText(chapterId);
  if (text.length > 0 && text.length <= FULL_CHAPTER_CHAR_BUDGET) {
    return { fullChapterText: text };
  }
  const sectionSummaries = useDataStore
    .getState()
    .blockSections.filter((s) => s.chapterId === chapterId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.summary)
    .filter((s) => s.trim().length > 0);
  if (sectionSummaries.length > 0) return { sectionSummaries };
  // No summaries but we do have (over-budget) prose — better to send it than nothing.
  return text.length > 0 ? { fullChapterText: text } : {};
}
