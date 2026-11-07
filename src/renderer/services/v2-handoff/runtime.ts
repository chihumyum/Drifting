// When the handoff runs (docs/v2-handoff.md): once in the background after
// the library opens, skipping documents open in an editor, and again inside
// the quit barrier, after editors are saved and Yjs queues drained. Both
// passes only touch documents whose revision moved since their entry.

import loglevel from 'loglevel';

import { getDb } from '../../lib/db';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import { materializeCanonicalNodeProse } from '../node-prose-metrics.service';
import { captureV2HandoffBooks } from './books';
import { runV2Handoff, type V2HandoffDependencies, type V2HandoffOptions, type V2HandoffResult } from './handoff';
import { registerV2HandoffFlush } from './lifecycle';
import { captureV2HandoffSettings } from './settings';

const log = loglevel.getLogger('v2-handoff');

/** Leave startup, the built-in sample and the first sync to themselves. */
export const V2_HANDOFF_STARTUP_DELAY_MS = 20_000;
/** The native quit deadline is 5 s for every flush step together. */
export const V2_HANDOFF_QUIT_BUDGET_MS = 1_500;

export function defaultV2HandoffDependencies(): V2HandoffDependencies {
  return {
    database: getDb,
    now: () => new Date().toISOString(),
    clock: () => performance.now(),
    async appVersion() {
      try {
        const { platform } = await import('../../platform');
        return await platform.app.getVersion();
      } catch {
        return null;
      }
    },
    captureSettings: () => captureV2HandoffSettings(),
    captureBooks: (projectIds) => captureV2HandoffBooks(projectIds),
    async refreshNode(projectId, nodeId) {
      await materializeCanonicalNodeProse(projectId, nodeId, undefined, {
        touchNodeUpdatedAt: false,
        publishToDataStore: useProjectStore.getState().currentProject?.id === projectId,
      });
    },
    publish(kind, entityId, json) {
      const store = useDataStore.getState();
      switch (kind) {
        case 'element':
          store.updateBookElement(entityId, { contentJson: json });
          return;
        case 'storyline':
          store.updateStoryline(entityId, { contentJson: json });
          return;
        case 'category':
          store.updateBookElementCategory(entityId, { contentJson: json });
          return;
        case 'library-item':
          store.updateLibraryItem(entityId, { bodyJson: json });
          return;
      }
    },
    isLive: (docId) => getLiveYDoc(docId) !== undefined,
    yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

/** Install once the library is open. Returns the uninstaller. */
export function installV2HandoffRuntime(
  dependencies: V2HandoffDependencies = defaultV2HandoffDependencies(),
  startupDelayMs = V2_HANDOFF_STARTUP_DELAY_MS,
): () => void {
  let disposed = false;
  let quitting = false;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = (options: V2HandoffOptions): Promise<V2HandoffResult> => {
    const run = tail.catch(() => undefined).then(() => runV2Handoff(options, dependencies));
    tail = run.catch(() => undefined);
    return run;
  };
  const report = (pass: string) => (result: V2HandoffResult) => {
    if (result.candidates > 0) log.info(`[v2-handoff] ${pass}`, result);
  };

  const timer = setTimeout(() => {
    if (disposed) return;
    void enqueue({ liveDocuments: 'skip', shouldStop: () => disposed || quitting })
      .then(report('background'))
      .catch((error) => log.warn('[v2-handoff] Background pass failed', error));
  }, startupDelayMs);

  const unregister = registerV2HandoffFlush(async () => {
    if (disposed) return;
    // A background pass stops at its next batch; the quit pass follows it.
    quitting = true;
    try {
      report('quit')(await enqueue({ liveDocuments: 'include', budgetMs: V2_HANDOFF_QUIT_BUDGET_MS }));
    } finally {
      quitting = false;
    }
  });

  return () => {
    disposed = true;
    clearTimeout(timer);
    unregister();
  };
}
