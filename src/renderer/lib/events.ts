import mitt from 'mitt';
import type { BookNode } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { EntityKind } from './extensions/entity-link';

export type SyncOperationEvent = {
  requestId: string;
  kind: 'yjs' | 'crud';
  phase: 'push' | 'pull';
  state: 'started' | 'succeeded' | 'failed';
  operation: 'create' | 'update' | 'delete' | 'softDelete' | 'restore' | 'push' | 'pull';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  endpoint: string;
  docId?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  projectId?: string;
  deviceId?: string;
  localUpdateCount?: number;
  remoteUpdateCount?: number;
  appliedUpdateCount?: number;
  skippedUpdateCount?: number;
  serverSeqCount?: number;
  resourceCount?: number;
  durationMs?: number;
  error?: string;
  at: number;
};

export type AppEvents = {
  'graph:select': { nodeId: string | null };
  'graph:node-created': { node: BookNode };
  'graph:node-updated': { nodeId: string; updates: Partial<BookNode> };
  'graph:node-deleted': { nodeId: string };

  'editor:saved': { nodeId: string; content: string };
  'editor:block-updated': { blockId: string; content: string };
  'editor:mention-detected': { blockId: string; mentions: string[] };

  'references:changed': {
    projectId: string;
    fromKind?: EntityKind;
    fromId?: string;
    targetKeys?: string[];
  };

  'element:element-created': { element: BookElement };
  'element:element-updated': { elementId: string; updates: Partial<BookElement> };
  'element:element-deleted': { elementId: string };
  'element:category-created': { categoryId: string };
  'element:category-updated': { categoryId: string; updates: Partial<BookElementCategory> };
  'element:category-deleted': { categoryId: string };
  'element:appearance-detected': { elementId: string; nodeId: string; blockId: string };

  'db:ready': void;
  'db:migrated': void;
  'db:error': { error: string };

  'search:query': { query: string };
  'search:results': { results: unknown[] };

  'jobs:started': { jobId: string; type: string };
  'jobs:completed': { jobId: string; result?: unknown };
  'jobs:failed': { jobId: string; error: string };

  'sync:operation': SyncOperationEvent;

  'ui:sidecar-toggled': { open: boolean };
  'ui:command-palette-toggled': { open: boolean };

  // topbar related
  // settings:open optionally carries a rail id so callers can deep-link
  // (e.g. user menu "键盘快捷键" → opens settings scrolled to the keys
  // panel). Empty payload = open at last position.
  'settings:open': { railId?: string };
  'search:open': void;
  'export:open': void;
  'import:open': void;
  'left-sidebar:toggle': void;
  'right-sidebar:toggle': void;
  'left-sidebar:collapse-all': void;

  'nodes:changed': void;

  // Copilot persisted a suggestion against the given (kind, id) target.
  // Consumed by useEntityMarginNotes to auto-open the comment rail when
  // copilot writes — otherwise suggestions land in a hidden margin and
  // the user has no signal.
  'copilot:suggestion-persisted': {
    targetKind: 'node' | 'element' | 'patch' | 'category' | 'storyline';
    targetId: string;
  };
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;
