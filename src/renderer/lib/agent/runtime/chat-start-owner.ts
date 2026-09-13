interface StartEntry {
  projectId: string;
  conversationId: string | null;
  invalid: boolean;
  submitted: boolean;
  cancelRuntime: boolean;
  discard: (() => void) | null;
}

/** One foreground preparation intent; submitted turns retain their own runtime
 * ownership after navigation. Releasing an old intent never unlocks a new one. */
export function createAgentChatStartOwner(setStarting: (value: boolean) => void) {
  let active: StartEntry | null = null;
  let disposed = false;
  const pending = new Set<StartEntry>();
  function discard(entry: StartEntry) {
    const cleanup = entry.discard; entry.discard = null; cleanup?.();
  }
  function invalidate(entry: StartEntry, cancelRuntime: boolean) {
    entry.invalid = true; entry.cancelRuntime ||= cancelRuntime;
    const wasActive = active === entry;
    if (wasActive) active = null;
    if (!entry.submitted) { pending.delete(entry); discard(entry); }
    if (wasActive) setStarting(false);
  }
  return {
    begin(projectId: string, conversationId: string | null) {
      if (active || disposed) return null;
      const entry: StartEntry = { projectId, conversationId, invalid: false,
        submitted: false, cancelRuntime: false, discard: null };
      active = entry; pending.add(entry); setStarting(true);
      return {
        isCurrent: (currentProjectId: string | null) => !entry.invalid && active === entry && currentProjectId === projectId,
        prepareTurn(id: string, cleanup: () => void) {
          entry.conversationId = id; entry.discard = cleanup;
          if (entry.invalid) discard(entry);
        },
        submit() {
          if (entry.invalid || active !== entry) return false;
          entry.submitted = true; entry.discard = null; return true;
        },
        shouldAbort: () => entry.cancelRuntime,
        finish() {
          const wasActive = active === entry;
          if (wasActive) active = null;
          entry.invalid = true; pending.delete(entry);
          if (!entry.submitted) discard(entry);
          if (wasActive) setStarting(false);
        },
      };
    },
    invalidate() { if (active) invalidate(active, false); },
    cancelConversation(id: string) {
      for (const entry of [...pending]) if (entry.conversationId === id) invalidate(entry, true);
    },
    cancelProject(id: string) {
      for (const entry of [...pending]) if (entry.projectId === id) invalidate(entry, true);
    },
    cancelActive() { if (active) invalidate(active, true); },
    dispose() { disposed = true; for (const entry of [...pending]) invalidate(entry, true); },
  };
}
