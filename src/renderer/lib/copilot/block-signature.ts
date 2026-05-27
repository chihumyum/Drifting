/**
 * Block-section signature: fingerprint of a section's block content used to
 * detect "the prose changed since this summary was written".
 *
 * Write path: stamp `signature = computeBlockSignature(blockIds, getText)` on
 * the section when it's created/updated.
 *
 * Read path: recompute the signature with the current Tiptap state before
 * using the section as prompt context. Mismatch → discard (the summary
 * describes prose that no longer exists in this form).
 *
 * Implementation note: this is a simple FNV-1a / djb2-style polynomial hash,
 * NOT a cryptographic one. We don't need collision resistance — we need a
 * cheap, deterministic fingerprint that changes when ANY of the underlying
 * block text changes. Stable across processes (no Math.random / Date.now),
 * so two devices syncing the same section will agree on its validity.
 */

/** djb2 variant operating on UTF-16 code units; good enough for change detection. */
function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i); // h * 33 ^ c
    h |= 0; // force 32-bit
  }
  return h >>> 0;
}

/** Convert a 32-bit unsigned int to base36 — short, URL-safe, comparable. */
function toCompact(n: number): string {
  return n.toString(36);
}

/**
 * Build the signature for an ordered list of block ids using the supplied
 * text resolver. Missing/empty blocks contribute an empty string (so a block
 * being deleted and a block being emptied produce different signatures from
 * a block being present and non-empty — but identical signatures otherwise,
 * which is fine: an empty block has no content to summarize either way).
 *
 * Format: `${blockCount}:${idsHash}:${textHash}` so we can spot-check
 * mismatches in logs (count-only changes vs. text-only changes look
 * different).
 */
export function computeBlockSignature(
  blockIds: string[],
  getBlockText: (blockId: string) => string,
): string {
  const idsHash = toCompact(hashString(blockIds.join('')));
  // Per-block hash chain — concatenating raw text would let two adjacent
  // blocks "merge" into one and still hash equal. Hash each block first,
  // then chain.  separator stays out of normal prose.
  let chain = 0;
  for (const id of blockIds) {
    const t = getBlockText(id) ?? '';
    chain = (chain * 31 + hashString(t)) >>> 0;
  }
  const textHash = toCompact(chain);
  return `${blockIds.length}:${idsHash}:${textHash}`;
}
