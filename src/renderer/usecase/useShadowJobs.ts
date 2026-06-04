import { useCallback, useEffect, useMemo } from 'react';
import { events } from '../lib/events';
import { useDataStore } from '../store/data-store';
import { createShadowJobRepository } from '../sqlite-repo/shadow-job-repo';
import {
  beginShadowJob,
  finishShadowJob,
  isShadowActive,
  isShadowCancelled,
  clearShadowCancelled,
} from '../lib/shadow/job-recorder';

/**
 * Owns the persisted shadow_job lifecycle on the renderer side. It:
 *   - loads a project's recent jobs into the data-store on open (loadInitial), and
 *   - subscribes to the main-process `shadow:job` IPC to begin / finish the
 *     persisted record AND emit the global `ai-task` notification for Shadow.
 *
 * The per-step evidence trail is appended from the shadow bridge handlers via the
 * job-recorder directly (they run in this same renderer process).
 */
export function useShadowJobs({ projectId }: { projectId: string }) {
  const loadInitial = useCallback(async () => {
    if (!projectId) return;
    const repo = createShadowJobRepository();
    const jobs = await repo.listByProject(projectId);
    // Reconcile orphaned 'running' rows: a review in-flight when the app/renderer
    // last closed never finalizes (its slow work — the judge — lived in the
    // renderer, which is gone). Left alone it shows a perpetual running cell.
    // Anything 'running' but not active in THIS session is stale → mark stopped.
    const at = new Date().toISOString();
    const reconciled = jobs.map((j) => {
      if (j.status !== 'running' || isShadowActive(j.chapterId)) return j;
      const trace = [...j.trace, { at, phase: 'decide' as const, label: '上次会话中断，自动结束' }];
      void repo.update(j.id, { status: 'stopped', finishedAt: at, trace });
      return { ...j, status: 'stopped' as const, finishedAt: at, updatedAt: at, trace };
    });
    useDataStore.getState().setShadowJobs(reconciled);
  }, [projectId]);

  useEffect(() => {
    const off = window.electronAPI?.shadow?.onJob?.((ev) => {
      const title =
        useDataStore.getState().bookNodes.find((n) => n.id === ev.chapterId)?.title || '章节';
      // A stopped review's trailing completed/failed IPC is suppressed (the job
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
    return () => off?.();
  }, []);

  // Memoize so the returned object is identity-stable across renders. App.tsx
  // lists this in its init-effect dep array; an unstable identity would retrigger
  // the whole project init (reloading nodes/storylines/mapping) on every render.
  return useMemo(() => ({ loadInitial }), [loadInitial]);
}
