import mitt from 'mitt';
import type { BookNode } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { EntityKind } from './extensions/entity-link';
import type { LeftSidebarTab, SidebarPaneId } from './sidebar-tabs';

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

  // An element's patches changed (e.g. the agent created/edited/deleted one) —
  // the open element editor's PatchesSection reloads. elementId omitted ⇒ reload
  // regardless (a delete that didn't resolve the owning element).
  'element:patches-changed': { elementId?: string };

  'db:ready': void;
  'db:migrated': void;
  'db:error': { error: string };
  /** The single App-wide cloud provider generation changed after durable activation. */
  'sync:authority-changed': void;
  'agent:conversation-committed': { projectId: string };
  'agent:conversations-changed': { projectId: string; conversationIds: string[] };
  /** Runtime persisted a provider binding state that product authority UI must re-read. */
  'sync:runtime-state-changed': void;
  /** A remote change-set committed locally after exact live-Yjs reconciliation. */
  'sync:project-changed': {
    projectId: string;
    /** Optional renderer-only scope; absence requires complete reference capture. */
    proseDocIds?: readonly string[];
    /** Pure prose is already live in Yjs; every other impact refreshes the workspace projection. */
    projectionImpact: 'prose-only' | 'workspace';
  };
  /** A recreated sync runtime cannot retain failed post-commit notifications. */
  'sync:reference-coverage-invalidated': { projectId: string };
  /** Fresh-device restore completed; tabs are device-local and must start clean. */
  'sync:projects-restored': { projectIds: string[] };

  'search:query': { query: string };
  'search:results': { results: unknown[] };

  'jobs:started': { jobId: string; type: string };
  'jobs:completed': { jobId: string; result?: unknown };
  'jobs:failed': { jobId: string; error: string };

  'ui:sidecar-toggled': { open: boolean };
  'ui:command-palette-toggled': { open: boolean };

  // topbar related
  // settings:open optionally carries a rail id so callers can deep-link
  // (e.g. user menu "键盘快捷键" → opens settings scrolled to the keys
  // panel). Empty payload = open at last position.
  'settings:open': { railId?: string };
  // Open the entity time-machine (snapshot history) modal for one prose
  // entity or material note. Emitted by the editor three-dot menu and the panel cell context
  // menu; consumed by the globally-mounted EntitySnapshotHistoryModal.
  'snapshot-history:open': {
    entityKind: 'node' | 'element' | 'storyline' | 'category' | 'library_item';
    entityId: string;
  };
  // Open the drift-binding picker modal for a timeline marker or an act.
  // Emitted by the marker pin / act band context menus; consumed by the
  // globally-mounted DriftBindModal, which performs the bind itself.
  'drift-bind:open': {
    target: { kind: 'marker' | 'act'; id: string };
  };
  'search:open': void;
  'import:open': void;
  'left-sidebar:toggle': void;
  'right-sidebar:toggle': void;
  'left-sidebar:collapse-all': { panel: LeftSidebarTab; paneId: SidebarPaneId | null };

  'nodes:changed': void;
  'comment:deleted': { commentId: string };

  // The agent's credential connection changed (connected/disconnected in
  // Settings) — the Agent panel listens to refresh its usable state.
  'agent:auth-changed': void;

  // A global BYOK provider key changed under Settings → Models & API. Feature
  // status indicators re-read their selected provider without owning another
  // credential form.
  'byok:keys-changed': void;
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;
