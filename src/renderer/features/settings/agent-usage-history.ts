import type { AgentConversationRemovalReceipt, AgentConversationUsage } from '../../sqlite-repo/agent-conversation-repo';
interface Binding { projectId: string | null; open: boolean; since?: string }
interface Ports {
  currentProjectId(): string | null;
  list(projectId: string, since?: string): Promise<AgentConversationUsage[]>;
  publish(rows: AgentConversationUsage[]): void;
  remove(id: string): Promise<AgentConversationRemovalReceipt[] | null>;
  clear(projectId: string): Promise<AgentConversationRemovalReceipt[] | null>;
  requestConfirmation(count: number): Promise<boolean>;
}

/** Settings history owns its query and confirmation lifetimes. Mutations stay
 * in the shared chat store; visible spend is always re-read from SQLite. */
export function createAgentUsageHistoryController(ports: Ports) {
  let binding: Binding | null = null;
  let request = 0;
  let disposed = false;
  const current = (owner: Binding) => !disposed && binding === owner && owner.open &&
    owner.projectId !== null && ports.currentProjectId() === owner.projectId;
  const refresh = () => {
    const owner = binding;
    if (!owner || !current(owner)) return;
    const sequence = ++request;
    void ports.list(owner.projectId!, owner.since).then(rows => {
      if (current(owner) && sequence === request) ports.publish(rows);
    }).catch(() => { if (current(owner) && sequence === request) ports.publish([]); });
  };
  return {
    bind(next: Binding) { if (disposed) return; binding = { ...next }; request++; refresh(); },
    unbind() { binding = null; request++; },
    async remove(id: string) {
      const owner = binding;
      if (!owner || !current(owner)) return;
      const receipt = await ports.remove(id);
      if (receipt !== null && current(owner)) refresh();
    },
    async clear(count: number) {
      const owner = binding;
      if (!owner || !current(owner) || count === 0) return;
      if (!(await ports.requestConfirmation(count)) || !current(owner)) return;
      const receipt = await ports.clear(owner.projectId!);
      if (receipt !== null && current(owner)) refresh();
    },
    dispose() { disposed = true; binding = null; request++; },
  };
}
