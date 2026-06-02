/**
 * Non-blocking confirmation for the agent's destructive tools (delete element /
 * comment / patch / relation).
 *
 * Replaces `window.confirm`, which (a) froze the whole renderer event loop and
 * (b) raced the 30s IPC bridge timeout — if the user sat on the prompt, the
 * bridge timed out and told the agent the tool FAILED, yet the delete still ran
 * (delete succeeds while the agent believes it failed).
 *
 * This renders an in-app dialog instead and AUTO-DECLINES after a timeout well
 * under the bridge's, so the tool always returns a clean confirmed/declined
 * result before the bridge gives up — and the destructive action only runs on an
 * explicit "allow".
 */
import { create } from 'zustand';

export interface PendingAgentConfirm {
  message: string;
  /** Resolve the request — wired to the in-flight promise + timeout cleanup. */
  respond: (ok: boolean) => void;
}

interface AgentConfirmState {
  pending: PendingAgentConfirm | null;
}

export const useAgentConfirmStore = create<AgentConfirmState>(() => ({ pending: null }));

/**
 * Ask the user to confirm a destructive agent action. Resolves true (allow),
 * false (cancel), or false on timeout. Non-blocking — shows AgentConfirmDialog.
 * Default 20s keeps it under the 30s bridge timeout.
 */
export function requestAgentConfirm(message: string, timeoutMs = 20000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // Clear the dialog only if this is still the active request (a newer
      // request may have replaced it).
      if (useAgentConfirmStore.getState().pending?.respond === respond) {
        useAgentConfirmStore.setState({ pending: null });
      }
      resolve(ok);
    };
    const respond = (ok: boolean): void => finish(ok);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    useAgentConfirmStore.setState({ pending: { message, respond } });
  });
}
