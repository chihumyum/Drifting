import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import type { AgentToolSelectionStrategy } from './types';

/** Full-schema fallback when discovery is disabled. Never guess task intent. */
export function createDriftingProductToolSelectionStrategy(): AgentToolSelectionStrategy {
  return createDriftingWorkspaceToolSelectionStrategy();
}
