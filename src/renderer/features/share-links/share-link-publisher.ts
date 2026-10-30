import { getActiveEditor } from '../../lib/active-editor';
import { events } from '../../lib/events';
import { createProjectionWorker } from '../../services/markdown-projection.service';
import { onAuthoredChangeCommitted } from '../../sync/journal/authored-transaction';
import { canShareLinks, republishShareLink, useShareLinkStore } from './share-link-store';

/** How old the link list may be when the publisher looks for this project's links. */
const PUBLISH_LIST_MAX_AGE_MS = 60_000;

/**
 * Project-scoped: after the author pauses, re-sends the copy of every link of
 * this project whose entity changed, here or through sync.
 */
export function installShareLinkPublisher(projectId: string): () => void {
  let disposed = false;
  const worker = createProjectionWorker(async () => {
    if (disposed || !canShareLinks()) return;
    const shares = await useShareLinkStore.getState().refresh(PUBLISH_LIST_MAX_AGE_MS);
    for (const link of shares) {
      if (disposed || link.projectId !== projectId) continue;
      await republishShareLink(link);
    }
  }, error => {
    console.warn('[share-links] Publishing will retry after the next change', error);
  }, () => Boolean(getActiveEditor()?.view.composing));
  const changed = (event: { projectId: string }) => { if (event.projectId === projectId) worker.request(); };
  const unsubscribe = onAuthoredChangeCommitted(changed);
  events.on('sync:project-changed', changed);
  // Catch up with edits made while no device was publishing.
  worker.request();
  return () => {
    unsubscribe();
    events.off('sync:project-changed', changed);
    // Closing the project sends what was written since the last pause.
    void worker.flush().finally(() => {
      disposed = true;
      worker.dispose();
    });
  };
}
