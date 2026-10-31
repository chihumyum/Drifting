import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react';
import { useCharSeaEnabled } from '../../components/char-sea/useCharSea';
import { onEditorStageReady } from '../../components/editor/editor-stage-ready';
import { charSeaRegistry } from '../../lib/char-sea/char-sea-registry';
import { LOADING_DELAY_MS } from '../../lib/motion';

// The longest a book waits under the sea for its stage. A surface that never
// reports ready (a chapter that is gone) is shown anyway.
export const WORKSPACE_OPENING_LIMIT_MS = 2000;
// Once the wait has shown (past the loading delay), it stays at least this
// long, so "Loading" is all the way up before it bursts; a book ready before
// the wait showed opens at once.
export const WORKSPACE_OPENING_SHOWN_MS = 600;

let covered = false;
const coverListeners = new Set<() => void>();

function setCovered(next: boolean): void {
  if (covered === next) return;
  covered = next;
  coverListeners.forEach((listener) => listener());
}

function subscribeCovered(listener: () => void): () => void {
  coverListeners.add(listener);
  return () => {
    coverListeners.delete(listener);
  };
}

/**
 * Opening a book on the desktop. The workspace mounts hidden (`data-opening`
 * on its root: transparent, still laid out, so the page it opens on can
 * prepare) while the sea of characters keeps the full-window wait the project
 * boot began, its hold taken in the same commit the boot's lets go. When the
 * editor stage first shows the page it wants with its content (and the wait,
 * if it showed, has shown for WORKSPACE_OPENING_SHOWN_MS), or after
 * WORKSPACE_OPENING_LIMIT_MS, the wait ends: the word bursts into rings and the
 * workspace comes up over the ebbing sea. Without the sea it is shown at once.
 */
export function useWorkspaceOpening(rootRef: RefObject<HTMLElement | null>): void {
  const seaEnabled = useCharSeaEnabled();
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!seaEnabled || !root) return undefined;
    root.dataset.opening = '';
    const release = charSeaRegistry.hold('loading');
    setCovered(true);
    let done = false;
    let stopListening = () => {};
    let limit = 0;
    let linger = 0;
    const finish = () => {
      if (done) return;
      done = true;
      stopListening();
      window.clearTimeout(limit);
      window.clearTimeout(linger);
      delete root.dataset.opening;
      setCovered(false);
      release();
    };
    const ready = () => {
      const since = charSeaRegistry.loadingSince();
      const shownAt = since === null ? Infinity : since + LOADING_DELAY_MS;
      const wait = shownAt + WORKSPACE_OPENING_SHOWN_MS - performance.now();
      if (performance.now() < shownAt || wait <= 0) finish();
      else linger = window.setTimeout(finish, wait);
    };
    stopListening = onEditorStageReady(ready);
    limit = window.setTimeout(finish, WORKSPACE_OPENING_LIMIT_MS);
    return finish;
  }, [rootRef, seaEnabled]);
}

/** Whether a book is opening under the sea right now (WorkspaceOpeningCover shows then). */
export function useWorkspaceOpeningCovered(): boolean {
  return useSyncExternalStore(subscribeCovered, () => covered, () => covered);
}
