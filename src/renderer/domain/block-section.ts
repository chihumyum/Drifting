/**
 * Block Section — rolling summary of a contiguous block range in one chapter.
 *
 * Produced as a side-effect of Copilot debounce runs (see lib/copilot/runtime
 * after PR C lands) and consumed by later debounces to give the model
 * recent-context cheaply, without re-feeding the raw prose of every block
 * the user has edited this session.
 *
 * Validity model: each row carries a `blockSignature` — a stable hash of
 * (blockIds + each block's text at write time). Read paths recompute the
 * signature using the current Tiptap state; if it doesn't match, the prose
 * has changed since the summary was written and the section is stale (drop
 * it, regenerate on the next run).
 */
export interface BlockSection {
  id: string;
  projectId: string;
  chapterId: string;
  /** Ordered block ids the summary covers. */
  blockIds: string[];
  /** Stable hash of (blockIds + current text per block) at write time. */
  blockSignature: string;
  summary: string;
  /** 'copilot-rolling' for now; 'reverse-outline' / 'manual' coming later. */
  source: BlockSectionSource;
  createdAt: string;
  updatedAt: string;
}

export type BlockSectionSource = 'copilot-rolling' | 'reverse-outline' | 'manual';

export function encodeBlockIds(blockIds: string[]): string {
  return JSON.stringify(blockIds);
}

export function decodeBlockIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}
