import loglevel from 'loglevel';

import type { BookElement } from '../domain/book-element';
import { linkElementsInClosedProse } from '../lib/agent/chapter-prose';
import { events, type AppEvents } from '../lib/events';
import type { ProseEntityType } from '../lib/yjs-doc-id';
import { useAgentChatStore } from '../store/agent-chat-store';
import { useDataStore } from '../store/data-store';

const log = loglevel.getLogger('ElementNameBackfill');
log.setLevel(loglevel.levels.WARN);

/** One prose document and the created elements still to link in it. */
interface Job {
  entityType: ProseEntityType;
  id: string;
  elementIds: Set<string>;
}

interface Document {
  entityType: ProseEntityType;
  id: string;
}

export interface ElementNameBackfillDependencies {
  linkInClosedDocument(projectId: string, document: Document, elementIds: readonly string[]): Promise<boolean>;
  /** Whether an Agent turn is running in the project. */
  agentBusy(projectId: string): boolean;
  /** Calls `listener` when the Agent's running turns may have changed. */
  onAgentActivity(listener: () => void): () => void;
}

const defaultDependencies: ElementNameBackfillDependencies = {
  linkInClosedDocument: (projectId, document, elementIds) =>
    linkElementsInClosedProse(projectId, document.entityType, document.id, elementIds),
  agentBusy: (projectId) => {
    const chat = useAgentChatStore.getState();
    return chat.boundProjectId === projectId && Object.keys(chat.runningTurns).length > 0;
  },
  onAgentActivity: (listener) => useAgentChatStore.subscribe(listener),
};

/** Every prose document of the open project that could mention `element`, but not its own. */
function documentsMentioning(projectId: string, element: BookElement): Document[] {
  const data = useDataStore.getState();
  if (data.workspaceProjectId !== projectId) return [];
  return [
    ...data.bookNodes.filter((node) => node.projectId === projectId).map((node) => ({ entityType: 'node' as const, id: node.id })),
    ...data.bookElements
      .filter((other) => other.projectId === projectId && other.id !== element.id)
      .map((other) => ({ entityType: 'element' as const, id: other.id })),
    ...data.storylines
      .filter((storyline) => storyline.projectId === projectId)
      .map((storyline) => ({ entityType: 'storyline' as const, id: storyline.id })),
    ...data.bookElementCategories
      .filter((category) => category.projectId === projectId)
      .map((category) => ({ entityType: 'category' as const, id: category.id })),
  ];
}

/**
 * A created element's names are linked in the project's closed prose, so its
 * appearances count before each chapter is opened (docs/editor/entity-links.md).
 * Open editors link it themselves. Documents are written one at a time, and
 * not while an Agent turn runs in the project: a link written between an
 * Agent's read and its write would make that write stale.
 */
export function retainElementNameBackfill(
  projectId: string,
  dependencies: ElementNameBackfillDependencies = defaultDependencies,
): () => void {
  // Insertion-ordered: each document is visited once for every element queued for it.
  const queue = new Map<string, Job>();
  let running = false;
  let disposed = false;

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (!disposed && queue.size > 0 && !dependencies.agentBusy(projectId)) {
        const [key, job] = queue.entries().next().value!;
        queue.delete(key);
        // An element deleted since it was created has nothing to link.
        const existing = new Set(useDataStore.getState().bookElements.map((element) => element.id));
        const elementIds = [...job.elementIds].filter((id) => existing.has(id));
        if (elementIds.length === 0) continue;
        try {
          await dependencies.linkInClosedDocument(projectId, job, elementIds);
        } catch (error) {
          log.warn('Linking a created element in closed prose failed:', error);
        }
      }
    } finally {
      running = false;
    }
  };

  const created = ({ element }: AppEvents['element:element-created']) => {
    if (disposed || element.projectId !== projectId) return;
    for (const document of documentsMentioning(projectId, element)) {
      const key = `${document.entityType}:${document.id}`;
      const job = queue.get(key) ?? { ...document, elementIds: new Set<string>() };
      job.elementIds.add(element.id);
      queue.set(key, job);
    }
    void pump();
  };

  events.on('element:element-created', created);
  const stopWatching = dependencies.onAgentActivity(() => {
    if (queue.size > 0 && !dependencies.agentBusy(projectId)) void pump();
  });
  return () => {
    if (disposed) return;
    disposed = true;
    events.off('element:element-created', created);
    stopWatching();
    queue.clear();
  };
}
