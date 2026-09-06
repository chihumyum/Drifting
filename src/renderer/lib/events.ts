import mitt from 'mitt';
import type { BookNode } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { EntityKind } from './extensions/entity-link';

// One Copilot-task lifecycle signal. Carries its
// `state` inline so a single subscription drives the
// global notification surface. `id` is stable across started→completed/failed so
// the notification center can collapse a task's phases into one row.
export type AiTaskSource = 'copilot';
export type AiTaskState = 'started' | 'completed' | 'failed' | 'stopped';
export type AiTaskOutcome = 'clean' | 'issues' | 'ok' | 'error';

export type AiTaskEvent = {
  id: string;
  source: AiTaskSource;
  state: AiTaskState;
  title: string; // short headline, e.g. "Copilot · 元素候选"
  detail?: string; // one-line detail, e.g. "第三章 · 发现 2 处问题"
  chapterId?: string; // for click-to-navigate, when applicable
  outcome?: AiTaskOutcome; // tints the completed banner
  count?: number; // findings / suggestions produced
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
    /** Pure prose is already live in Yjs; every other impact refreshes the workspace projection. */
    projectionImpact: 'prose-only' | 'workspace';
  };
  /** Fresh-device restore completed; tabs are device-local and must start clean. */
  'sync:projects-restored': { projectIds: string[] };

  'search:query': { query: string };
  'search:results': { results: unknown[] };

  'jobs:started': { jobId: string; type: string };
  'jobs:completed': { jobId: string; result?: unknown };
  'jobs:failed': { jobId: string; error: string };

  // Copilot task lifecycle → global notification pill + center.
  'ai-task': AiTaskEvent;

  'ui:sidecar-toggled': { open: boolean };
  'ui:command-palette-toggled': { open: boolean };

  // topbar related
  // settings:open optionally carries a rail id so callers can deep-link
  // (e.g. user menu "键盘快捷键" → opens settings scrolled to the keys
  // panel). Empty payload = open at last position.
  'settings:open': { railId?: string };
  // Open the entity time-machine (snapshot history) modal for one prose
  // entity. Emitted by the editor three-dot menu and the panel cell context
  // menu; consumed by the globally-mounted EntitySnapshotHistoryModal.
  'snapshot-history:open': {
    entityKind: 'node' | 'element' | 'storyline' | 'category';
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
  'left-sidebar:collapse-all': void;

  'nodes:changed': void;
  'comment:deleted': { commentId: string };

  // The agent's credential connection changed (connected/disconnected in
  // Settings) — the Agent panel listens to refresh its usable state.
  'agent:auth-changed': void;

  // A global BYOK provider key changed under Settings → Models & API. Feature
  // status indicators re-read their selected provider without owning another
  // credential form.
  'byok:keys-changed': void;

  // Copilot persisted a suggestion against the given (kind, id) target.
  // Announces a newly persisted Copilot review item. Review surfaces may use
  // this as an unread signal; it never auto-mounts or opens an editor rail.
  'copilot:suggestion-persisted': {
    targetKind: 'node' | 'element' | 'patch' | 'category' | 'storyline';
    targetId: string;
  };

  // User explicitly asked Copilot to run a capability NOW (Cmd+Shift+I / copilot
  // menu), bypassing the per-capability debounce and dedup gate. Consumed by
  // the useCopilot instance whose chapter (nodeId) matches — it forces a
  // fire even if the capability's per-task toggle is off, and even when
  // automatic Copilot is disabled (manual is never gated by those switches).
  // `instruction` is the optional free-text steer the user typed in the
  // popover; it's threaded into the capability's prompt. `selectionBlockIds`,
  // when present (Task 6), scopes the run to those blocks + the segments they
  // fall into, instead of the rolling coverage context.
  'copilot:manual-run': {
    nodeId: string;
    capId: string;
    instruction?: string;
    selectionBlockIds?: string[];
  };
};

export const eventBus = mitt<AppEvents>();

export const events = eventBus;
