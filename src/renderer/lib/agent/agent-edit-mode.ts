/** General Agent writes always commit directly. The test-only override exercises
 * historical SQLite review recovery without exposing a product mode switch. */
import type { AgentEditMode } from '../../store/agent-edit-store';

let legacyTestMode: AgentEditMode | null = null;

export function setAgentEditModeOverride(mode: AgentEditMode | null): void {
  if (import.meta.env.MODE === 'test') legacyTestMode = mode;
}

export function effectiveAgentEditMode(): AgentEditMode {
  return import.meta.env.MODE === 'test' ? legacyTestMode ?? 'auto' : 'auto';
}
