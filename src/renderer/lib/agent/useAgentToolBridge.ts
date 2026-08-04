/**
 * Publishes the live project/Yjs write runtime used by renderer-local tools.
 *
 * The legacy name is kept while call sites migrate. General Agent has its own
 * replaceable transport; this context remains available to renderer-local
 * restore flows.
 */
import { useEffect, useRef } from 'react';
import {
  setActiveAgentToolContext,
  type AgentToolContext,
  type AgentWriteApi,
} from './tool-handlers';

export function useAgentToolBridge(projectId: string, write: AgentWriteApi): void {
  const ctxRef = useRef<AgentToolContext>({ projectId, write });

  // Refresh the ref AFTER each commit (not during render — the compiler forbids ref
  // writes in render), and publish the same ctx so non-React callers reuse the
  // live write usecases. Clear only on unmount to avoid a momentary null.
  useEffect(() => {
    ctxRef.current = { projectId, write };
    setActiveAgentToolContext(ctxRef.current);
  });
  useEffect(() => () => setActiveAgentToolContext(null), []);
}
