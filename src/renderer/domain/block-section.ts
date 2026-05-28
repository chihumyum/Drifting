/**
 * Block Section — rolling summary of a contiguous block range in one chapter.
 *
 * Produced by the Copilot framework when uncovered blocks accumulate past a
 * threshold (see lib/copilot/produce-block-section-summary). Consumed by
 * every capability via `baseContext.priorSections` for cheap recent-context
 * recall without re-feeding raw prose.
 *
 * Validity model (per-block hashes, post PR D-1):
 *   - `blockHashes` stores each covered block's text hash at write time.
 *   - The coverage-map reader recomputes each block's hash against current
 *     Tiptap state; mismatching blocks become "uncovered" individually but
 *     the section's summary is still served for the unchanged ones.
 *   - This is what makes a one-block mid-chapter edit not invalidate the
 *     surrounding 20-block summary.
 */
export interface BlockSection {
  id: string;
  projectId: string;
  chapterId: string;
  /** Ordered block ids the summary covers. */
  blockIds: string[];
  /**
   * Per-block content fingerprint at write time. Map keyed by blockId. A
   * blockId missing from this map is treated as never-hashed (always
   * considered stale on read) — should never happen post-D-1 but covers
   * data migrated from the pre-D-1 single-signature column.
   */
  blockHashes: Record<string, string>;
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

export function encodeBlockHashes(map: Record<string, string>): string {
  return JSON.stringify(map);
}

export function decodeBlockHashes(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
