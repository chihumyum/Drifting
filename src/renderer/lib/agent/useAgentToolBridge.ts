/**
 * Wires the main-process agent tool requests to the renderer-side handlers.
 * Mounted once inside the project Layout (where projectId is known). Subscribes
 * to `agent:tool-exec`, runs the tool, and replies on `agent:tool-result`.
 */
import { useEffect } from 'react';
import { runAgentTool, type AgentToolContext } from './tool-handlers';

export function useAgentToolBridge(projectId: string): void {
  useEffect(() => {
    const api = window.electronAPI?.agent;
    if (!api?.onToolExec) return undefined;

    const ctx: AgentToolContext = { projectId };
    return api.onToolExec(async (req) => {
      try {
        const data = await runAgentTool(req.name, req.args, ctx);
        api.sendToolResult({ id: req.id, ok: true, data });
      } catch (err) {
        api.sendToolResult({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }, [projectId]);
}
