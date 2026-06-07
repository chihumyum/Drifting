import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../store/settings-store';
import { useStaleReviews } from './useStaleReviews';
import { enqueueShadowReview, isShadowActive } from '../lib/shadow/job-recorder';

/**
 * Shadow auto-run. When the `shadowAutoRun` setting is on, a finished chapter whose
 * canon dependencies changed since its last review (the "stale" set, see
 * useStaleReviews) is re-reviewed automatically — no manual 复审 needed. Off keeps
 * the existing behavior (manual + review-on-mark-finished only).
 *
 * Idempotency: enqueueShadowReview already coalesces (reuses the chapter's
 * non-terminal row) and no-ops while a review is active, so re-runs of this effect
 * can't double-queue. We also keep a per-session `triggered` set so a chapter that
 * is mid-re-review (still in the stale set until its NEW review finishes) isn't
 * re-enqueued every recompute; entries clear once a chapter leaves the stale set,
 * so a fresh staleness later re-triggers it.
 */
export function useShadowAutoRun({ projectId }: { projectId: string }): void {
  const autoRun = useSettingsStore((s) => s.shadowAutoRun);
  const staleReviews = useStaleReviews(projectId);
  const triggered = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!autoRun || !projectId) return;
    const staleIds = new Set(staleReviews.map((r) => r.chapterId));
    // Forget chapters that are no longer stale (a finished re-review) so they can
    // auto-trigger again if their deps change later.
    for (const id of triggered.current) {
      if (!staleIds.has(id)) triggered.current.delete(id);
    }
    for (const r of staleReviews) {
      if (triggered.current.has(r.chapterId)) continue;
      if (isShadowActive(r.chapterId)) continue;
      triggered.current.add(r.chapterId);
      void enqueueShadowReview(r.chapterId, projectId);
    }
  }, [autoRun, projectId, staleReviews]);
}
