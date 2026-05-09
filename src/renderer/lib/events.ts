import mitt from 'mitt';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';

export type AppEvents = {
  'graph:select': { nodeId: string | null };
  'graph:node-created': { node: BookNode };
  'graph:node-updated': { nodeId: string; updates: Partial<BookNode> };
  'graph:node-deleted': { nodeId: string };
  'graph:edge-created': { edge: BookNodeEdge };
  'graph:edge-deleted': { edgeId: string };

  'editor:saved': { nodeId: string; content: string };
  'editor:block-updated': { blockId: string; content: string };
  'editor:mention-detected': { blockId: string; mentions: string[] };

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

  'ui:sidecar-toggled': { open: boolean };
  'ui:command-palette-toggled': { open: boolean };

  // topbar related
  'settings:open': void;
  'search:open': void;
  'left-sidebar:toggle': void;
  'right-sidebar:toggle': void;

  'nodes:changed': void;
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;
