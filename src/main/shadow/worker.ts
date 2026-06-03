import type { BrowserWindow } from 'electron';
import type { ShadowJobInput, ShadowJobResult } from './types';
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

// Run one chapter review to completion and report the verdict.
export async function runShadowJob(job: ShadowJobInput): Promise<ShadowJobResult> {
  const graph = await getGraph();
  const final = await graph.invoke({ chapterId: job.chapterId, projectId: job.projectId });
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

export function enqueueShadowJob(job: ShadowJobInput): void {
  if (queue.some((j) => j.chapterId === job.chapterId)) return; // coalesce dupes
  queue.push(job);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        await runShadowJob(job);
      } catch (err) {
        console.error('[shadow] job failed —', job.chapterId, err);
      }
    }
  } finally {
    running = false;
  }
}
