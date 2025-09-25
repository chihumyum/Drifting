import mitt from 'mitt';

export type AppEvents = {
  'graph:select': { nodeId: string | null };
  'graph:node-created': { node: import('../schema/table').StoryNode };
  'graph:node-updated': { nodeId: string; updates: Partial<import('../schema/table').StoryNode> };
  'graph:node-deleted': { nodeId: string };
  'graph:edge-created': { edge: import('../schema/table').NodeEdge };
  'graph:edge-deleted': { edgeId: string };
  
  'editor:saved': { nodeId: string; content: string };
  'editor:block-updated': { blockId: string; content: string };
  'editor:mention-detected': { blockId: string; mentions: string[] };
  
  'entity:entity-created': { entity: import('../model/domain').Entity };
  'entity:entity-updated': { entityId: string; updates: Partial<import('../model/domain').Entity> };
  'entity:entity-deleted': { entityId: string };
  'entity:category-created': { categoryId: string };
  'entity:category-updated': { categoryId: string; updates: Partial<import('../schema/table').EntityCategory> };
  'entity:category-deleted': { categoryId: string };
  'entity:appearance-detected': { entityId: string; nodeId: string; blockId: string };
  
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
  
  'nodes:changed': void;
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;
