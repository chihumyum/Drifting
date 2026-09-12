import type { AgentChatMessage } from '../../domain/agent-conversation';
import type { useAgentChatStore } from '../../store/agent-chat-store';
import { mayDeferAgentChatMessages } from '../../lib/agent/runtime/chat-message-publication';

type State = ReturnType<typeof useAgentChatStore.getState>;
interface Source {
  getState(): State;
  subscribe(listener: (state: State) => void): () => void;
}
export interface AgentChatDisplayScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
  isHidden(): boolean;
  subscribeVisibility(callback: () => void): () => void;
}

const empty: AgentChatMessage[] = [];
function select(state: State) {
  const id = state.activeConvId;
  const run = id ? state.runs[id] : undefined;
  return { id, projectId: state.boundProjectId, run, messages: run?.messages ?? empty,
    turnId: id ? state.runningTurns[id] : undefined, starting: state.starting };
}

/** Coalesces only display notifications. Canonical ingestion/persistence stays synchronous. */
export function createAgentChatDisplayProjection(source: Source, scheduler: AgentChatDisplayScheduler) {
  const listeners = new Set<() => void>();
  let latest: ReturnType<typeof select> | undefined;
  let snapshot = empty;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disconnect: (() => void) | undefined;
  let detachVisibility: (() => void) | undefined;

  function cancelScheduled() {
    if (frame !== undefined) scheduler.cancelFrame(frame);
    if (timer !== undefined) scheduler.clearTimer(timer);
    frame = undefined;
    timer = undefined;
  }
  function flush() {
    cancelScheduled();
    if (!listeners.size) return;
    latest = select(source.getState());
    if (snapshot === latest.messages) return;
    snapshot = latest.messages;
    for (const listener of listeners) listener();
  }
  function changed(state: State) {
    const previous = latest;
    latest = select(state);
    if (!previous) { flush(); return; }
    const ownerChanged = latest.id !== previous.id || latest.projectId !== previous.projectId;
    const controlChanged = latest.turnId !== previous.turnId || latest.starting !== previous.starting
      || latest.run?.controlStatus !== previous.run?.controlStatus
      || latest.run?.pendingControl !== previous.run?.pendingControl
      || latest.run?.lastTerminal !== previous.run?.lastTerminal;
    if (!ownerChanged && !controlChanged && latest.run === previous.run) return;
    // Non-message changes to this run (Stop, author actions, recovery) are also
    // flush boundaries. Unrelated conversations do not flush the visible stream.
    if (ownerChanged || controlChanged || latest.messages === previous.messages
      || !mayDeferAgentChatMessages(latest.messages) || scheduler.isHidden()) {
      flush();
      return;
    }
    if (frame === undefined) frame = scheduler.requestFrame(flush);
    if (timer === undefined) timer = scheduler.setTimer(flush, 50);
  }
  return {
    getSnapshot: () => listeners.size ? snapshot : select(source.getState()).messages,
    subscribe(listener: () => void) {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) {
        latest = select(source.getState());
        snapshot = latest.messages;
        disconnect = source.subscribe(changed);
        detachVisibility = scheduler.subscribeVisibility(() => { if (scheduler.isHidden()) flush(); });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        // No queued callback or stale display snapshot survives the last view.
        cancelScheduled();
        disconnect?.(); disconnect = undefined;
        detachVisibility?.(); detachVisibility = undefined;
        // Do not retain a run/transcript after disconnect: it may be deleted
        // while no chat view is mounted. Unobserved reads use canonical state.
        latest = undefined; snapshot = empty;
      };
    },
  };
}
