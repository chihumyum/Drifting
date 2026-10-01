import { useMemo, useSyncExternalStore } from 'react';
import { useAgentChatViewSource } from './AgentChatViewContext';
import { createAgentChatDisplayProjection, type AgentChatDisplayScheduler } from './chat-display-projection';

const scheduler: AgentChatDisplayScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (id) => clearTimeout(id),
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribeVisibility: (callback) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
};

function useDisplay() {
  const source = useAgentChatViewSource();
  return useMemo(() => createAgentChatDisplayProjection(source, scheduler), [source]);
}

/** Scoped to the visual chat view; runtime and persistence read the canonical store. */
export function useAgentChatMessages() {
  const display = useDisplay();
  return useSyncExternalStore(display.subscribe, display.getSnapshot, display.getSnapshot);
}

/** Tree snapshots keep ordinary transcript views off the full-array boundary. */
export function useAgentChatTranscript() {
  const display = useDisplay();
  return useSyncExternalStore(display.subscribe, display.getTranscriptSnapshot, display.getTranscriptSnapshot);
}
