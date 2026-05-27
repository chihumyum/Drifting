/**
 * Map an LLM-returned evidence span back to the block id it came from.
 *
 * Capabilities feed the model a `recentText` formed by concatenating
 * `baseContext.editedBlocks`. The model returns an `evidenceText` quote.
 * To anchor the resulting comment to the right block, we substring-search
 * the edited block list and return the matching block's id.
 *
 * Matching is verbatim (case-sensitive) — same as evidence text quotes are
 * verbatim excerpts of the user's prose. Returns undefined when no block
 * contains the evidence; the runner then falls back to the first edited
 * block (always non-empty by base-block-context's invariant).
 */
import type { BlockSnippet } from '../ai/context/types';

export function findEvidenceBlock(
  blocks: BlockSnippet[],
  evidenceText: string,
): string | undefined {
  const needle = evidenceText.trim();
  if (!needle) return undefined;

  // Try whole-evidence substring first; fastest and handles most cases.
  for (const block of blocks) {
    if (block.text.includes(needle)) return block.blockId;
  }

  // Fallback: if evidence is long and crosses a block boundary (concat
  // joiner inside the quote), match on the first ~20-char chunk that any
  // block contains. Cheap salvage so we anchor *somewhere* near the source.
  const head = needle.slice(0, 20);
  if (head.length >= 6) {
    for (const block of blocks) {
      if (block.text.includes(head)) return block.blockId;
    }
  }
  return undefined;
}
