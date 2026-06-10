/**
 * Wires the main-process agent tool requests to the renderer-side handlers.
 * Mounted once inside the project Layout (where projectId + usecases live).
 * Subscribes to `agent:tool-exec`, runs the tool, replies on `agent:tool-result`.
 *
 * The latest context (projectId + write usecases) is held in a ref so the
 * subscription is set up once yet always calls the current usecase functions.
 */
import { useEffect, useRef } from 'react';
import {
  runAgentTool,
  setActiveAgentToolContext,
  type AgentToolContext,
  type AgentWriteApi,
} from './tool-handlers';

/** Compact, low-noise summary of a tool call's key id args for the log. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const keys = ['nodeId', 'elementId', 'storylineId', 'categoryId', 'blockId', 'kind', 'name'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** Trace every agent tool call (name, key args, ok/error, latency) to the console. */
function logToolCall(name: string, args: Record<string, unknown>, ok: boolean, ms: number, err?: unknown): void {
  console.debug(
    `[agent tool] ${ok ? '✓' : '✗'} ${name} ${Math.round(ms)}ms`,
    summarizeArgs(args),
    err ? (err instanceof Error ? err.message : String(err)) : '',
  );
}

export function useAgentToolBridge(projectId: string, write: AgentWriteApi): void {
  const ctxRef = useRef<AgentToolContext>({ projectId, write });

  // Refresh the ref AFTER each commit (not during render — the compiler forbids ref
  // writes in render), and publish the same ctx so non-React callers (the Shadow-FC
  // evolve editor) reuse the live write usecases. Clear only on unmount, so a
  // concurrent evolve never reads a momentary null.
  useEffect(() => {
    ctxRef.current = { projectId, write };
    setActiveAgentToolContext(ctxRef.current);
  });
  useEffect(() => () => setActiveAgentToolContext(null), []);

  useEffect(() => {
    const api = window.electronAPI?.agent;
    if (!api?.onToolExec) return undefined;

    return api.onToolExec(async (req) => {
      const t0 = performance.now();
      try {
        const data = await runAgentTool(req.name, req.args, ctxRef.current);
        logToolCall(req.name, req.args, true, performance.now() - t0);
        api.sendToolResult({ id: req.id, ok: true, data });
      } catch (err) {
        logToolCall(req.name, req.args, false, performance.now() - t0, err);
        api.sendToolResult({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }, []);
}
