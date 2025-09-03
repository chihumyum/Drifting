import mitt from 'mitt';

export type AppEvents = {
  'graph:select': { nodeId: string | null };
  'graph:node-created': { node: import('./schema').StoryNode };
  'graph:node-updated': { nodeId: string; updates: Partial<import('./schema').StoryNode> };
  'graph:node-deleted': { nodeId: string };
  'graph:edge-created': { edge: import('./schema').NodeEdge };
  'graph:edge-deleted': { edgeId: string };
  
  'editor:saved': { nodeId: string; content: string };
  'editor:block-updated': { blockId: string; content: string };
  'editor:mention-detected': { blockId: string; mentions: string[] };
  
  'codex:entry-created': { entry: import('./schema').Entry };
  'codex:entry-updated': { entryId: string; updates: Partial<import('./schema').Entry> };
  'codex:entry-deleted': { entryId: string };
  'codex:appearance-detected': { entryId: string; nodeId: string; blockId: string };
  
  'db:ready': void;
  'db:migrated': void;
  'db:error': { error: string };
  
  'search:query': { query: string };
  'search:results': { results: unknown[] };
  
  'jobs:started': { jobId: string; type: string };
  'jobs:completed': { jobId: string; result?: unknown };
  'jobs:failed': { jobId: string; error: string };
  
  'ui:view-changed': { view: 'graph' | 'tree' | 'timeline' | 'editor' | 'codex' };
  'ui:sidecar-toggled': { open: boolean };
  'ui:command-palette-toggled': { open: boolean };
  
  'nodes:changed': void;
  'entries:changed': void;
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;


