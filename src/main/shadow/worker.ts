import type { BrowserWindow } from 'electron';
import type { ShadowJobInput, ShadowJobResult, ShadowJobEvent } from './types';
import { callRenderer } from '../agent/bridge';
import { buildShadowGraph } from './graph';
import { createShadowDeps } from './deps';

type GetWindow = () => BrowserWindow | null;

// Set once at startup (registerShadowIpc). The graph's deps bridge to the
// renderer through this window via callRenderer.
let getWindowRef: GetWindow | null = null;
export function initShadowWorker(getWindow: GetWindow): void {
  getWindowRef = getWindow;
}

// Push a lifecycle signal to the renderer (notification feed + persisted job row).
function emitJobEvent(ev: ShadowJobEvent): void {
  try {
    getWindowRef?.()?.webContents.send('shadow:job', ev);
  } catch {
    /* window gone — nothing to notify */
  }
}

// The compiled graph is cached after first build. LangGraph is loaded lazily via
// a Vite-ignored dynamic import (ESM, externalized) — same pattern as the Agent
// SDK at src/main/agent/index.ts. Shadow bridge calls get a longer timeout than
// the default since some (semantic eval) make an LLM round-trip.
let compiledGraph: ReturnType<typeof buildShadowGraph> | null = null;

async function getGraph(): Promise<ReturnType<typeof buildShadowGraph>> {
  if (compiledGraph) return compiledGraph;
  if (!getWindowRef) throw new Error('shadow worker not initialized (call registerShadowIpc)');
  const getWindow = getWindowRef;
  const lg = await import(/* @vite-ignore */ '@langchain/langgraph');
  const call = (name: string, args: Record<string, unknown>) =>
    callRenderer(getWindow, name, args, 120_000);
  compiledGraph = buildShadowGraph(lg, createShadowDeps(call));
  return compiledGraph;
}

// Run one chapter review to completion and report the verdict. An optional signal
// lets cancelShadowJob bail the run between graph steps (the in-flight LLM fetch is
// aborted renderer-side; this is belt-and-suspenders for the gap between nodes).
export async function runShadowJob(
  job: ShadowJobInput,
  signal?: AbortSignal,
): Promise<ShadowJobResult> {
  const graph = await getGraph();
  const final = await graph.invoke(
    { chapterId: job.chapterId, projectId: job.projectId },
    signal ? { signal } : undefined,
  );
  return {
    chapterId: job.chapterId,
    decision: final.decision ?? 'finished',
    findingCount: final.findings.length,
  };
}

// Minimal in-memory serial queue. v1 only — replace with a persisted
// `shadow_jobs` table (survives restart), proper coalescing, and cancel-on-
// revert-to-draft. The LangGraph checkpointer (run-internal resume) is a
// separate concern from this job queue (which job to run next).
const queue: ShadowJobInput[] = [];
let running = false;
// AbortController for the job currently in drain(), keyed by chapterId. Lets
// cancelShadowJob interrupt an already-started run, not just dequeue a pending one.
const runControllers = new Map<string, AbortController>();

export function enqueueShadowJob(job: ShadowJobInput): void {
  if (queue.some((j) => j.chapterId === job.chapterId)) return; // coalesce dupes
  queue.push(job);
  void drain();
}

// User asked to stop a review. Drop it from the queue if it hasn't started; if it's
// already running, abort its controller — the renderer aborts its in-flight LLM
// fetch (the heavy work lives there) and the rejection unwinds graph.invoke, so the
// serial queue frees immediately for the next job instead of blocking till the LLM
// round-trip finishes.
export function cancelShadowJob(chapterId: string): void {
  const i = queue.findIndex((j) => j.chapterId === chapterId);
  if (i !== -1) queue.splice(i, 1);
  runControllers.get(chapterId)?.abort();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      emitJobEvent({ chapterId: job.chapterId, projectId: job.projectId, state: 'started' });
      const controller = new AbortController();
      runControllers.set(job.chapterId, controller);
      try {
        const result = await runShadowJob(job, controller.signal);
        emitJobEvent({
          chapterId: job.chapterId,
          projectId: job.projectId,
          state: 'completed',
          decision: result.decision,
          findingCount: result.findingCount,
        });
      } catch (err) {
        console.error('[shadow] job failed —', job.chapterId, err);
        emitJobEvent({
          chapterId: job.chapterId,
          projectId: job.projectId,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        runControllers.delete(job.chapterId);
      }
    }
  } finally {
    running = false;
  }
}
