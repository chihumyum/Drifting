import { useSyncExternalStore } from 'react';
import { useAgentChatStore } from '../../store/agent-chat-store';
import { createAgentChatDisplayProjection } from './chat-display-projection';

const display = createAgentChatDisplayProjection(useAgentChatStore, {
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
});

/** Shared by visual chat consumers; runtime and persistence read the canonical store. */
export function useAgentChatMessages() {
  return useSyncExternalStore(display.subscribe, display.getSnapshot, display.getSnapshot);
}

/** Tree snapshots keep ordinary transcript views off the full-array boundary. */
export function useAgentChatTranscript() {
  return useSyncExternalStore(display.subscribe, display.getTranscriptSnapshot, display.getTranscriptSnapshot);
}
