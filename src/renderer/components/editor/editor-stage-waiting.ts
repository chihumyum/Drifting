import { useSyncExternalStore } from 'react';

/**
 * The top-level tab the editor stage wants in front but cannot show yet,
 * once its page has been preparing longer than LOADING_DELAY_MS. The dock
 * lets that tab's glass drift until the page arrives. EditorMainArea owns the
 * value; nothing else writes it.
 */
let waitingTabKey: string | null = null;
const listeners = new Set<() => void>();

export function editorStageWaiting(): string | null {
  return waitingTabKey;
}

export function setEditorStageWaiting(tabKey: string | null): void {
  if (waitingTabKey === tabKey) return;
  waitingTabKey = tabKey;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab whose page the stage is waiting on, or null. */
export function useEditorStageWaiting(): string | null {
  return useSyncExternalStore(subscribe, editorStageWaiting, () => null);
}
