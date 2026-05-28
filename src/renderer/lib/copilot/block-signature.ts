/**
 * Block-content fingerprints for coverage-map staleness detection.
 *
 * Write path: when producing a block_section, hash each covered block's
 * current text and store as `{ [blockId]: hash }` (see domain/block-section).
 *
 * Read path: the coverage map walks each section's stored hashes and
 * recomputes against the editor's current state. Per-block mismatch means
 * THAT block changed since the summary was written — it gets pulled out of
 * "covered" into "uncovered" while the section's summary stays valid for
 * the remaining unchanged blocks. This is the mechanism that makes a
 * mid-chapter edit not blow up the whole section's context.
 *
 * Hash is a simple djb2 variant — not cryptographic; we need a cheap,
 * deterministic change detector. Stable across processes / devices so two
 * clients syncing the same section agree on its validity.
 */

/** djb2 over UTF-16 code units; output as 32-bit unsigned base36 string. */
function hashCodeUnits(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i); // h * 33 ^ c
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Hash a single block's text. Empty text hashes to a distinguishable value
 * (not just empty string) so we can detect "block emptied" vs "block missing".
 */
export function computeBlockHash(text: string): string {
  return hashCodeUnits(text);
}

/**
 * Build the full hash map for a section's blockIds, using a text resolver.
 * Missing/empty blocks contribute their (empty-text) hash, not undefined —
 * so an emptied block still appears in the map and is detectable as "was
 * non-empty, now empty" by comparing stored hash to current.
 */
export function computeBlockHashes(
  blockIds: string[],
  getBlockText: (blockId: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of blockIds) {
    out[id] = computeBlockHash(getBlockText(id) ?? '');
  }
  return out;
}
