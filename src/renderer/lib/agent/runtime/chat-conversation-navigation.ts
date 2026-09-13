import type { AgentConversationSummary } from '../../../domain/agent-conversation';

export interface AgentConversationLoadToken {
  generation: number;
  projectId: string;
}

/** Latest-intent gate for asynchronous conversation hydration. */
export class AgentConversationLoadGuard {
  private generation = 0;

  begin(projectId: string): AgentConversationLoadToken {
    this.generation += 1;
    return { generation: this.generation, projectId };
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: AgentConversationLoadToken, currentProjectId: string | null): boolean {
    return token.generation === this.generation && token.projectId === currentProjectId;
  }
}

interface ListPorts {
  read(): { projectId: string | null; activeConvId: string | null; prompt: string; starting: boolean };
  list(projectId: string): Promise<AgentConversationSummary[]>;
  publish(rows: AgentConversationSummary[]): void;
  lastConversation(projectId: string): string | undefined;
  restore(id: string, isCurrent: () => boolean): Promise<void>;
}

/** Lists belong to a binding and request; restoration belongs to author intent.
 * No panel owns this lifetime. Completed/failed stale reads cannot publish. */
export function createAgentConversationListController(ports: ListPorts) {
  let binding = 0;
  let request = 0;
  let intent = 0;
  let disposed = false;
  let restoreProject: string | null = null;
  return {
    bind(projectId: string, restore: boolean) {
      binding++; request++; intent++;
      restoreProject = restore ? projectId : null;
    },
    cancelRestore() { intent++; restoreProject = null; },
    refresh() {
      const projectId = ports.read().projectId;
      if (!projectId || disposed) return;
      const generation = binding; const sequence = ++request;
      const current = () => !disposed && generation === binding && sequence === request && ports.read().projectId === projectId;
      void (async () => {
        let rows: AgentConversationSummary[];
        try { rows = await ports.list(projectId); } catch { rows = []; }
        if (!current()) return;
        ports.publish(rows);
        if (!current() || restoreProject !== projectId) return;
        const state = ports.read();
        if (state.activeConvId || state.prompt || state.starting) return;
        const lastId = ports.lastConversation(projectId);
        restoreProject = null;
        if (!lastId || !rows.some(row => row.id === lastId)) return;
        const restoringIntent = intent;
        // List refreshes may continue during hydration. They cannot cancel or
        // repeat this restoration; only a new binding/author intent can.
        const isCurrent = () => !disposed && binding === generation && intent === restoringIntent && ports.read().projectId === projectId;
        try { await ports.restore(lastId, isCurrent); } catch { /* Keep the empty view when recovery is unavailable. */ }
      })();
    },
    dispose() { disposed = true; binding++; request++; intent++; restoreProject = null; },
  };
}
