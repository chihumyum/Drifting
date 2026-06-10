/**
 * Per-element runtime state for /goal 一键演化.
 *
 * The evolve run state (running / phase / result) is keyed by elementId so each
 * element editor shows ITS OWN evolve — switching elements never bleeds one
 * element's result into another's panel. The run is driven from here (not the
 * component) so it survives navigation: start an evolve, go read a chapter while
 * it edits, come back — the panel still reflects the live run.
 *
 * NOT persisted: the prose edits themselves are durable (Yjs + the agent-edit
 * store); this is just the in-flight orchestration view, fine to drop on reload.
 *
 * The AbortController per element lives OUTSIDE the store (a plain Map) — it's not
 * render state, and aborting must not churn subscribers.
 */
import { create } from 'zustand';
import { evolveElement } from '../lib/goal/evolve-element';
import type { ElementChange, EvolveResult, EvolveTraceStep } from '../lib/goal/types';

export interface EvolveRunState {
  running: boolean;
  phase: string;
  result: EvolveResult | null;
  /** Inspectable trail: every critic 查证/裁决 round + editor tool call, in arrival
   *  order, capped (oldest dropped) so a big run can't bloat the store. */
  trace: EvolveTraceStep[];
}

export const EMPTY_EVOLVE: EvolveRunState = { running: false, phase: '', result: null, trace: [] };

const TRACE_CAP = 800;

interface EvolveStore {
  byElement: Record<string, EvolveRunState>;
  run: (
    elementId: string,
    projectId: string,
    change: ElementChange,
    opts?: { dryRun?: boolean; force?: boolean; includeDrafts?: boolean },
  ) => Promise<void>;
  stop: (elementId: string) => void;
}

const controllers = new Map<string, AbortController>();

export const useEvolveStore = create<EvolveStore>((set, get) => {
  const patch = (elementId: string, p: Partial<EvolveRunState>) =>
    set((s) => ({
      byElement: { ...s.byElement, [elementId]: { ...(s.byElement[elementId] ?? EMPTY_EVOLVE), ...p } },
    }));

  return {
    byElement: {},
    run: async (elementId, projectId, change, opts = {}) => {
      if (get().byElement[elementId]?.running) return; // already running for this element
      const controller = new AbortController();
      controllers.set(elementId, controller);
      patch(elementId, { running: true, phase: '', result: null, trace: [] });
      const pushTrace = (ev: EvolveTraceStep) =>
        set((s) => {
          const cur = s.byElement[elementId] ?? EMPTY_EVOLVE;
          const trace = cur.trace.length >= TRACE_CAP ? [...cur.trace.slice(-(TRACE_CAP - 1)), ev] : [...cur.trace, ev];
          return { byElement: { ...s.byElement, [elementId]: { ...cur, trace } } };
        });
      try {
        // evolveElement returns a result even on abort (stopReason 'aborted') —
        // it doesn't throw. The catch is for genuine failures.
        const r = await evolveElement(projectId, change, {
          ...opts,
          signal: controller.signal,
          log: (msg) => patch(elementId, { phase: msg }),
          onTrace: pushTrace,
        });
        patch(elementId, { running: false, result: r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patch(elementId, {
          running: false,
          phase: controller.signal.aborted ? '已手动停止' : `失败：${msg}`,
        });
      } finally {
        controllers.delete(elementId);
      }
    },
    stop: (elementId) => {
      controllers.get(elementId)?.abort();
    },
  };
});
