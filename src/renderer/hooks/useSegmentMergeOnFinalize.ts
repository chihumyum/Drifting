/**
 * useSegmentMergeOnFinalize (Task 5, part A) — watch this chapter's writing
 * status; when it transitions out of 'draft' into a "moving forward" state
 * (finished / waiting_review / revising) AND every block is currently covered
 * by a segment summary, auto-run the segment merge to consolidate the small
 * rolling summaries.
 *
 * Fires only on the genuine draft→finalize transition during the session (not
 * on mount), gated by the Copilot master + summary switches. 'discarded' is
 * excluded — no point summarizing a parked chapter.
 */
import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { isChapter } from '../domain/book-node';
import { computeCoverageMap } from '../lib/copilot/coverage-map';
import { mergeChapterSegments } from '../lib/copilot/merge-chapter-segments';

const log = loglevel.getLogger('copilot:merge-finalize');
const FINALIZE_STATUSES = new Set(['finished', 'waiting_review', 'revising']);

export interface UseSegmentMergeOnFinalizeInput {
  editor: Editor;
  projectId: string;
  nodeId: string;
}

export function useSegmentMergeOnFinalize({
  editor,
  projectId,
  nodeId,
}: UseSegmentMergeOnFinalizeInput): void {
  const enabled = useSettingsStore((s) => s.copilotEnabled);
  const summaries = useSettingsStore((s) => s.copilotGenerateSummaries);
  const status = useDataStore((s) => {
    const n = s.bookNodes.find((x) => x.id === nodeId);
    return n && isChapter(n) ? n.writingStatus : undefined;
  });
  const prevRef = useRef<string | undefined>(status);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = status;
    if (!enabled || !summaries) return;
    if (prev === undefined || prev === status) return;
    // Only the draft → finalize moment.
    if (prev !== 'draft' || !status || !FINALIZE_STATUSES.has(status)) return;

    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const coverage = await computeCoverageMap({ editor, chapterId: nodeId });
      if (cancelled) return;
      if (coverage.uncoveredBlocks.length > 0) {
        log.info(
          `[merge-finalize] skip — ${coverage.uncoveredBlocks.length} uncovered block(s)`,
        );
        return;
      }
      log.info(`[merge-finalize] ${nodeId.slice(0, 8)} → ${status}; merging segments`);
      await mergeChapterSegments({ editor, projectId, chapterId: nodeId, signal: controller.signal });
    })().catch((err) => log.warn('[merge-finalize] failed', err));

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [status, enabled, summaries, editor, projectId, nodeId]);
}
