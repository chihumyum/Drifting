/**
 * Wires the main-process agent tool requests to the renderer-side handlers.
 * Mounted once inside the project Layout (where projectId + usecases live).
 * Subscribes to `agent:tool-exec`, runs the tool, replies on `agent:tool-result`.
 *
 * The latest context (projectId + write usecases) is held in a ref so the
 * subscription is set up once yet always calls the current usecase functions.
 */
import { useEffect, useRef } from 'react';
import { runAgentTool, type AgentToolContext, type AgentWriteApi } from './tool-handlers';

export function useAgentToolBridge(projectId: string, write: AgentWriteApi): void {
  const ctxRef = useRef<AgentToolContext>({ projectId, write });
  ctxRef.current = { projectId, write };

  useEffect(() => {
    const api = window.electronAPI?.agent;
    if (!api?.onToolExec) return undefined;

    return api.onToolExec(async (req) => {
      try {
        const data = await runAgentTool(req.name, req.args, ctxRef.current);
        api.sendToolResult({ id: req.id, ok: true, data });
      } catch (err) {
        api.sendToolResult({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }, []);
}
