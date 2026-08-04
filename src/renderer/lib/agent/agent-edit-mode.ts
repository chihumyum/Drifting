/**
 * Edit-mode override for Agent prose edits. The write path normally uses the
 * General Agent's `agentEditMode`; focused runtimes and tests may temporarily
 * override it. Process-global under the singleton-agent assumption.
 */
import { useSettingsStore, type AgentEditMode } from '../../store/settings-store';

let override: AgentEditMode | null = null;

export function setAgentEditModeOverride(mode: AgentEditMode | null): void {
  override = mode;
}

/** The mode the write path should record an edit with right now. */
export function effectiveAgentEditMode(): AgentEditMode {
  return override ?? useSettingsStore.getState().agentEditMode;
}
