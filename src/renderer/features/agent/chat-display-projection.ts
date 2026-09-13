import { AgentChatTranscript } from '../../domain/agent-chat-transcript';
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

const empty = AgentChatTranscript.from([]);
function select(state: State) {
  const id = state.activeConvId;
  const run = id ? state.runs[id] : undefined;
  return { id, projectId: state.boundProjectId, run, transcript: run?.transcript,
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
  let scheduledGeneration = 0;
  let connectionGeneration = 0;

  function cancelScheduled() {
    // Cancellation cannot retract a callback already queued by the host. It
    // must not flush a later owner, burst or remounted view.
    scheduledGeneration++;
    if (frame !== undefined) scheduler.cancelFrame(frame);
    if (timer !== undefined) scheduler.clearTimer(timer);
    frame = undefined;
    timer = undefined;
  }
  function flush() {
    cancelScheduled();
    if (!listeners.size) return;
    latest = select(source.getState());
    const messages = latest.transcript ?? empty;
    if (snapshot === messages) return;
    snapshot = messages;
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
    if (ownerChanged || controlChanged || latest.transcript === previous.transcript
      || (!latest.transcript || !mayDeferAgentChatMessages(latest.transcript))) {
      flush();
      return;
    }
    const generation = scheduledGeneration;
    const scheduledFlush = () => { if (generation === scheduledGeneration) flush(); };
    // A hidden view still consumes the canonical stream. Coalesce its display
    // work behind one timer instead of flattening history for every delta.
    // The host may throttle timers; control and visibility boundaries flush
    // synchronously without waiting for either host callback.
    if (!scheduler.isHidden() && frame === undefined) frame = scheduler.requestFrame(scheduledFlush);
    if (timer === undefined) timer = scheduler.setTimer(scheduledFlush, 50);
  }
  return {
    getSnapshot: () => (listeners.size ? snapshot : (select(source.getState()).transcript ?? empty)).toArray(),
    getTranscriptSnapshot: () => listeners.size ? snapshot : (select(source.getState()).transcript ?? empty),
    subscribe(listener: () => void) {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) {
        const connection = ++connectionGeneration;
        latest = select(source.getState());
        snapshot = latest.transcript ?? empty;
        disconnect = source.subscribe(changed);
        detachVisibility = scheduler.subscribeVisibility(() => { if (connection === connectionGeneration) flush(); });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        // No queued callback or stale display snapshot survives the last view.
        connectionGeneration++;
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
