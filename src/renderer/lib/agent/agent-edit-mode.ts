/**
 * Edit-mode override for agent prose edits. The write path records each edit with an
 * AgentEditMode — by default the GENERAL agent's `agentEditMode`. A Shadow-module
 * operation (e.g. /goal evolve) sets an override so its edits record with the Shadow
 * module's own mode instead: same write mechanism, module-scoped setting. Process-
 * global; safe under the singleton-agent assumption (no concurrent chat turn).
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
