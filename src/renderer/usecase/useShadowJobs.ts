import { useCallback, useEffect, useMemo } from 'react';
import { events } from '../lib/events';
import { useDataStore } from '../store/data-store';
import { createShadowJobRepository } from '../sqlite-repo/shadow-job-repo';
import {
  beginShadowJob,
  enqueueShadowReview,
  finishShadowJob,
  isShadowActive,
  isShadowCancelled,
  clearShadowCancelled,
} from '../lib/shadow/job-recorder';
import {
  configureShadowRuntime,
  createRendererShadowDeps,
  subscribeShadowJobEvents,
} from '../lib/shadow/runtime';
import { getActiveAgentToolContext, runAgentTool } from '../lib/agent/tool-handlers';

/**
 * Owns the persisted shadow_job lifecycle on the renderer side. It:
 *   - loads a project's recent jobs into the data-store on open (loadInitial), and
 *   - configures the in-renderer review runtime and subscribes to its lifecycle
 *     events to begin / finish the persisted row and emit `ai-task` notifications.
 *
 * The per-step evidence trail is appended from the Shadow handlers via the
 * job-recorder directly (they run in this same renderer process).
 */
export function useShadowJobs({ projectId }: { projectId: string }) {
  const loadInitial = useCallback(async () => {
    if (!projectId) return;
    const repo = createShadowJobRepository();
    const jobs = await repo.listByProject(projectId);
    // Durable queue reconciliation. A review in-flight when the app/renderer last
    // closed never finalized (its slow work — the judge — lived in the renderer,
    // which is gone). Demote orphaned 'running' rows back to 'queued' so they can
    // be RESUMED (resumeQueued, after nodes load, re-dispatches the ones whose
    // chapter is still waiting_review). 'queued' rows (enqueued but never started)
    // stay queued. Nothing is active yet on a fresh load, so the active-check just
    // guards a same-session re-entry.
    const at = new Date().toISOString();
    const reconciled = jobs.map((j) => {
      if (j.status !== 'running' || isShadowActive(j.chapterId)) return j;
      const trace = [...j.trace, { at, phase: 'decide' as const, label: '上次会话中断，排队续跑' }];
      void repo.update(j.id, { status: 'queued', finishedAt: null, trace });
      return { ...j, status: 'queued' as const, finishedAt: null, updatedAt: at, trace };
    });
    useDataStore.getState().setShadowJobs(reconciled);
    // Bound on-disk growth — these telemetry rows accumulate forever otherwise.
    // Fire-and-forget so it never delays the UI; only rows beyond the cap (older
    // than anything we load/show) are removed.
    void repo.pruneOldJobs(projectId).catch(() => {});
  }, [projectId]);

  // Resume the durable queue once nodes are loaded (call AFTER loadNodes). For
  // each persisted 'queued' row: re-dispatch it if its chapter is still locked in
  // waiting_review (a genuine interrupted review); otherwise the user moved on —
  // finalize it as 'stopped' so it doesn't hang in the queue forever.
  const resumeQueued = useCallback(async () => {
    if (!projectId) return;
    const repo = createShadowJobRepository();
    const s = useDataStore.getState();
    const queued = s.shadowJobs.filter((j) => j.projectId === projectId && j.status === 'queued');
    const at = new Date().toISOString();
    for (const j of queued) {
      if (isShadowActive(j.chapterId)) continue;
      const node = s.bookNodes.find((n) => n.id === j.chapterId);
      if (node?.writingStatus === 'waiting_review') {
        void enqueueShadowReview(j.chapterId, projectId);
      } else {
        const trace = [
          ...j.trace,
          { at, phase: 'decide' as const, label: '已不在审阅队列，自动结束' },
        ];
        void repo.update(j.id, { status: 'stopped', finishedAt: at, trace });
        useDataStore
          .getState()
          .upsertShadowJob({ ...j, status: 'stopped', finishedAt: at, updatedAt: at, trace });
      }
    }
  }, [projectId]);

  useEffect(() => {
    configureShadowRuntime(
      createRendererShadowDeps(async (name, args) => {
        const ctx = getActiveAgentToolContext();
        if (!ctx) throw new Error('Shadow runtime is not mounted in an active project');
        const requestedProjectId = args.projectId;
        if (typeof requestedProjectId === 'string' && requestedProjectId !== ctx.projectId) {
          throw new Error(
            `Shadow project changed during review (${requestedProjectId} -> ${ctx.projectId})`,
          );
        }
        return runAgentTool(name, args, ctx);
      }),
    );

    return subscribeShadowJobEvents((ev) => {
      const title =
        useDataStore.getState().bookNodes.find((n) => n.id === ev.chapterId)?.title || '章节';
      // A stopped review's trailing completed/failed event is suppressed (the job
      // is already finalized as 'stopped'); clear the flag once it arrives.
      if (ev.state !== 'started' && isShadowCancelled(ev.chapterId)) {
        clearShadowCancelled(ev.chapterId);
        return;
      }
      if (ev.state === 'started') {
        void beginShadowJob(ev.chapterId, ev.projectId);
        events.emit('ai-task', {
          id: `shadow:${ev.chapterId}`,
          source: 'shadow',
          state: 'started',
          title: 'Shadow 审阅',
          detail: title,
          chapterId: ev.chapterId,
          at: Date.now(),
        });
        return;
      }
      if (ev.state === 'failed') {
        void finishShadowJob(ev.chapterId, ev.projectId, { status: 'failed', error: ev.error });
        events.emit('ai-task', {
          id: `shadow:${ev.chapterId}`,
          source: 'shadow',
          state: 'failed',
          title: 'Shadow 审阅',
          detail: title,
          chapterId: ev.chapterId,
          error: ev.error || '审阅失败',
          at: Date.now(),
        });
        return;
      }
      // completed
      const clean = ev.decision === 'finished';
      const count = ev.findingCount ?? 0;
      void finishShadowJob(ev.chapterId, ev.projectId, {
        status: 'done',
        decision: ev.decision ?? null,
        findingCount: count,
      });
      events.emit('ai-task', {
        id: `shadow:${ev.chapterId}`,
        source: 'shadow',
        state: 'completed',
        title: 'Shadow 审阅',
        detail: clean ? `通过 · ${title}` : `${count} 处待改 · ${title}`,
        chapterId: ev.chapterId,
        outcome: clean ? 'clean' : 'issues',
        count,
        at: Date.now(),
      });
    });
  }, []);

  // Memoize so the returned object is identity-stable across renders. App.tsx
  // lists this in its init-effect dep array; an unstable identity would retrigger
  // the whole project init (reloading nodes/storylines/mapping) on every render.
  return useMemo(() => ({ loadInitial, resumeQueued }), [loadInitial, resumeQueued]);
}
