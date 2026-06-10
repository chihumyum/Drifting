/**
 * Renderer-side execution of the agent's entity tools.
 *
 * Reads come from the live in-memory data store (single-project) plus the
 * content repo for prose. Everything is scoped to the active project. P1 is
 * read-only; write handlers are added in P2 and call the usecases so agent
 * edits go through the same optimistic-update + sync path as manual edits.
 */
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createProjectRuleRepository } from '../../sqlite-repo/project-rule-repo';
import {
  evaluateSemanticAssertionAgentic,
  evaluateSemanticAssertionsFC,
  type AgenticTraceStep,
  type EvidenceCatalog,
  type EvidenceProvider,
  type EvidenceRequest,
  type SemanticEvalContext,
  type SemanticViolation,
  type ToolRunOutcome,
} from '../ai/shadow-rules';
import { buildShadowClient } from '../ai/client/build-default-client';
import {
  resolveShadowModel,
  ensureShadowModelRoutable,
  SHADOW_TIER_MODEL,
} from '../shadow/model-routing';
import { recordShadowUsage } from '../shadow/usage';
import { resolveWritingLanguage } from '../ai/output-language';
import type { AIMessage, AITool, AIToolCall } from '../ai/types';
import { AGENT_READ_TOOLS, toAITools } from './tool-registry';
import { yieldToMain } from '../async/yield-to-main';
import {
  setShadowConsulted,
  traceShadow,
  throwIfShadowCancelled,
  registerShadowAborter,
} from '../shadow/job-recorder';
import { computeChangedDeps, snapshotConsulted } from '../shadow/dep-snapshot';
import type { ShadowConsultedKind, ShadowConsultedRef, ShadowToolCall } from '../../domain/shadow-job';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import {
  createElementPatchRepository,
  type CreatePatchInput,
  type UpdatePatchInput,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import {
  syncElementPatchCreate,
  syncElementPatchUpdate,
} from '../../usecase/sync-helpers';
import { isChapter, type BookNode } from '../../domain/book-node';
import { parseKv, stringifyKv, type KvEntry } from '../../domain/kv';
import {
  commentIdsRelatedToEntity,
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getBlockSnapshotFromAnchor,
  getSelectedTextFromAnchor,
} from '../../domain/comment';
import type { CreateCommentInput } from '../../usecase/useComment';
import type { CommentKind } from '../../domain/comment';
import {
  createMemory,
  listLiveMemories,
  loadActiveMemories,
  setMemoryStatus,
  softDeleteMemory,
} from '../../usecase/useAgentMemory';
import type { AgentMemoryKind } from '../../domain/agent-memory';
import type { NodeContent } from '../../domain/node-content';
import {
  isEntityKind,
  isStructuralEntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
  type StructuralEntityKind,
} from '../../domain/entity-kinds';
import type {
  CreateBookElementInput,
  UpdateElementUsecaseInput,
} from '../../usecase/useBookElement';
import type { CreateStorylineInput, UpdateStorylineInput } from '../../usecase/useStoryline';
import type {
  CreateElementCategoryInput,
  UpdateElementCategoryInput,
} from '../../usecase/useElementCategory';
import type { CreateNodeUsecaseInput } from '../../usecase/useBookNode';
import type { UpdateProjectInput } from '../../usecase/useProject';
import {
  docToBlocks,
  docToPlainText,
  replaceBlockText,
  replaceBlockByIndex,
  blocksToCompactText,
  appendParagraph,
  removeBlocks,
  replaceBlockRange,
  insertBlocks,
  findBlocks,
  makeParagraphBlock,
} from './serialize';
import {
  getChapterContentJson,
  writeEntityProse,
  getEntityContentJson,
  getElementContentJson,
  yReplaceBlockText,
  yRemoveBlocks,
  yReplaceBlockRange,
  yInsertBlocks,
  yAppendParagraph,
  yReplaceAllParagraphs,
  beginProseReadCache,
  endProseReadCache,
} from './chapter-prose';
import { proseDocId, isProseEntityType, type ProseEntityType } from '../yjs-doc-id';
import { getLiveYDoc } from '../yjs-doc-registry';
import { eventBus } from '../events';
import { requestAgentConfirm } from '../../store/agent-confirm-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { effectiveAgentEditMode } from './agent-edit-mode';
import type { AgentBlockChange } from './block-diff';
import { entityKey, type ActivityEntityType } from './tool-entity-ref';
import { summaryFieldChange, kvFieldChanges, patchFieldChange, fieldBlockId } from './field-diff';

/**
 * Merge facts into an existing kv list by key (upsert). Unlike update_element's
 * replace semantics, project/storyline/category KV is higher-value (style, POV,
 * goals) so the agent setting one fact must not wipe the author's other facts.
 */
function mergeKv(existingJson: string | null | undefined, updates: KvEntry[]): string {
  const map = new Map<string, string>();
  for (const e of parseKv(existingJson)) map.set(e.key, e.value);
  for (const u of updates) {
    if (!u.key) continue;
    map.set(u.key, u.value);
  }
  return stringifyKv([...map.entries()].map(([key, value]) => ({ key, value })));
}

/**
 * Seed the edit-review store with the agent's NON-PROSE field edits (summary /
 * kv / template kv), so they surface for review exactly like prose edits do
 * (soft-approval: the write already landed; this just records what changed).
 * Stamps the current global mode so auto/approve is frozen per-change. No-op
 * when nothing actually changed.
 */
function recordFieldChanges(
  entityType: ActivityEntityType,
  id: string,
  changes: AgentBlockChange[],
): void {
  if (changes.length === 0) return;
  useAgentEditStore
    .getState()
    .record(entityType, id, changes, effectiveAgentEditMode());
}

/** Patch ids this element has SOFT-deleted (agent ran delete_element_patch, but
 *  the row stays until the user confirms on the card). The agent's patch reads
 *  hide these so its view matches its belief that they're gone. */
function pendingDeletedPatchIds(elementId: string): Set<string> {
  const entry = useAgentEditStore.getState().pending[entityKey('element', elementId)];
  return new Set(
    (entry?.changes ?? [])
      .filter((c) => c.field?.kind === 'patch' && c.op === 'deleted')
      .map((c) => c.field?.key)
      .filter((k): k is string => !!k),
  );
}

/** Coerce a loose facts array (from tool args) to KvEntry[]. */
function toKvEntries(raw: unknown): KvEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KvEntry[] = [];
  for (const row of raw) {
    if (row && typeof row === 'object') {
      const key = typeof (row as KvEntry).key === 'string' ? (row as KvEntry).key : '';
      const value = typeof (row as KvEntry).value === 'string' ? (row as KvEntry).value : '';
      if (key || value) out.push({ key, value });
    }
  }
  return out;
}

/**
 * The subset of renderer usecase functions the agent's write tools call.
 * Wiring through these (not the repos directly) keeps agent edits on the same
 * optimistic-update + sync-outbox path as manual edits.
 */
export interface AgentWriteApi {
  updateElement: (id: string, updates: UpdateElementUsecaseInput) => Promise<unknown>;
  createElement: (input: CreateBookElementInput) => Promise<unknown>;
  renameNode: (id: string, title: string) => Promise<unknown>;
  updateNode: (
    id: string,
    updates: Partial<BookNode> & { mainStorylineId?: string | null },
  ) => Promise<unknown>;
  updateContentByNodeId: (nodeId: string, updates: Partial<NodeContent>) => Promise<unknown>;
  addNodeToStoryline: (nodeId: string, storylineId: string) => Promise<void>;
  removeNodeFromStoryline: (nodeId: string, storylineId: string) => Promise<void>;
  setNodeStorylines: (
    nodeId: string,
    storylineIds: string[],
    options?: { primaryStorylineId?: string | null },
  ) => Promise<void>;
  addRelation: (
    fromKind: EntityRefSourceKind,
    fromId: string,
    toKind: EntityRefTargetKind,
    toId: string,
    options?: { kind?: string | null },
  ) => Promise<unknown>;
  removeRelation: (id: string) => Promise<unknown>;
  updateRelationKind: (id: string, kind: string | null) => Promise<unknown>;
  removeElement: (id: string) => Promise<unknown>;
  createStoryline: (input: CreateStorylineInput) => Promise<unknown>;
  updateStoryline: (input: UpdateStorylineInput) => Promise<unknown>;
  createCategory: (input: CreateElementCategoryInput) => Promise<unknown>;
  updateCategory: (id: string, updates: UpdateElementCategoryInput) => Promise<unknown>;
  updateProject: (id: string, updates: UpdateProjectInput) => Promise<unknown>;
  createNode: (input: CreateNodeUsecaseInput) => Promise<unknown>;
  createComment: (input: CreateCommentInput) => Promise<unknown>;
  deleteComment: (id: string) => Promise<unknown>;
  resolveComment: (id: string) => Promise<unknown>;
  reopenComment: (id: string) => Promise<unknown>;
  convertToTodo: (id: string) => Promise<unknown>;
  revertToNote: (id: string) => Promise<unknown>;
  setCommentKind: (id: string, kind: CommentKind) => Promise<unknown>;
}

export interface AgentToolContext {
  projectId: string;
  write: AgentWriteApi;
}

/** The live tool context (projectId + write usecases) published by the mounted
 *  useAgentToolBridge. Lets NON-React callers reuse the SAME write usecases the chat
 *  agent uses: the Shadow-FC evolve editor runs runAgentTool('edit_block', …) directly
 *  in the renderer, and without a real `write` every edit throws "Cannot read
 *  properties of undefined (reading 'updateContentByNodeId')". null when no project
 *  Layout is mounted (e.g. the dev harness). */
let activeAgentToolContext: AgentToolContext | null = null;
export function setActiveAgentToolContext(ctx: AgentToolContext | null): void {
  activeAgentToolContext = ctx;
}
export function getActiveAgentToolContext(): AgentToolContext | null {
  return activeAgentToolContext;
}

// Names are project-unique, so the list/read tools return NAMES (not long
// uuids) and the read/edit tools accept a name OR an id — see resolveRef. This
// keeps the agent's context lean.

function listChapters(ctx: AgentToolContext) {
  const s = useDataStore.getState();
  const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
  const storylineName = (id: string | null) =>
    id ? (s.storylines.find((sl) => sl.id === id)?.name ?? undefined) : undefined;
  return {
    storylines: s.storylines
      .filter((sl) => sl.projectId === ctx.projectId)
      .map((sl) => ({ name: sl.name, summary: sl.summary || undefined })),
    chapters: nodes.filter(isChapter).map((n) => ({
      name: n.title,
      status: n.writingStatus,
      words: n.wordCount,
      storyline: storylineName(s.primaryStorylineByNode[n.id] ?? null),
    })),
    drifts: nodes
      .filter((n) => n.kind === 'drift')
      .map((n) => ({ name: n.title, status: n.writingStatus })),
  };
}

function listElements(ctx: AgentToolContext) {
  const s = useDataStore.getState();
  const catName = (id: string | null) =>
    id ? (s.bookElementCategories.find((c) => c.id === id)?.name ?? undefined) : undefined;
  return {
    categories: s.bookElementCategories
      .filter((c) => c.projectId === ctx.projectId)
      .map((c) => ({ name: c.name })),
    elements: s.bookElements
      .filter((e) => e.projectId === ctx.projectId)
      .map((e) => ({
        name: e.name,
        category: catName(e.categoryId),
        summary: e.summary || undefined,
      })),
  };
}

/**
 * Resolve a name-or-id to a concrete id within a kind (names are project-unique
 * — see #11). An exact id passes through; otherwise it's matched by name
 * (case-insensitive; elements also match aliases). Throws a helpful error on
 * not-found or (legacy) ambiguity so the agent can fall back to an id.
 */
function resolveRef(
  ctx: AgentToolContext,
  kind: 'node' | 'element' | 'storyline' | 'category',
  ref: string,
): string {
  const r = (ref ?? '').trim();
  if (!r) throw new Error(`missing ${kind} reference (name or id)`);
  const s = useDataStore.getState();
  const low = r.toLowerCase();
  const fail = (label: string, matches: { id: string }[]): never => {
    if (matches.length === 0) throw new Error(`No ${label} named "${r}"`);
    throw new Error(
      `"${r}" matches ${matches.length} ${label}s — pass one of these ids: ${matches
        .map((m) => m.id)
        .join(', ')}`,
    );
  };
  if (kind === 'node') {
    const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
    if (nodes.some((n) => n.id === r)) return r;
    const m = nodes.filter((n) => n.title.trim().toLowerCase() === low);
    return m.length === 1 ? m[0].id : fail('chapter/drift', m);
  }
  if (kind === 'element') {
    const els = s.bookElements.filter((e) => e.projectId === ctx.projectId);
    if (els.some((e) => e.id === r)) return r;
    const m = els.filter((e) => [e.name, ...e.aliases].some((n) => n.trim().toLowerCase() === low));
    return m.length === 1 ? m[0].id : fail('element', m);
  }
  if (kind === 'storyline') {
    const sls = s.storylines.filter((x) => x.projectId === ctx.projectId);
    if (sls.some((x) => x.id === r)) return r;
    const m = sls.filter((x) => x.name.trim().toLowerCase() === low);
    return m.length === 1 ? m[0].id : fail('storyline', m);
  }
  const cats = s.bookElementCategories.filter((x) => x.projectId === ctx.projectId);
  if (cats.some((x) => x.id === r)) return r;
  const m = cats.filter((x) => x.name.trim().toLowerCase() === low);
  return m.length === 1 ? m[0].id : fail('category', m);
}

function normalizeEntityKind(kind: string): 'node' | 'element' | 'storyline' | 'category' | null {
  switch (kind) {
    case 'node':
    case 'chapter':
    case 'drift':
      return 'node';
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'category':
      return 'category';
    default:
      return null;
  }
}

/** Resolve a (kind, name-or-id) pair; unknown kinds (e.g. 'patch') pass through. */
function resolveByKind(ctx: AgentToolContext, kind: string, ref: string): string {
  const k = normalizeEntityKind(kind);
  return k ? resolveRef(ctx, k, ref) : ref;
}

/**
 * Resolve the entity-ref args (a NAME — or an id — the agent passed) to a real
 * id BEFORE dispatch. The agent-facing params are the clear names
 * `chapter`/`element`/`storyline`/`category`; the handlers still read the
 * internal *Id fields, so we resolve the external name and write the internal id
 * (legacy *Id args are also accepted, for robustness).
 */
function resolveArgsRefs(ctx: AgentToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  // `node` is the neutral name for chapter|drift (they share one namespace);
  // `chapter` is the chapter-only spelling — both resolve to nodeId. `legacy`
  // marks the pre-rename *Id spellings we still accept for robustness.
  const map: Array<{ ext: string; internal: string; kind: 'node' | 'element' | 'storyline' | 'category' }> = [
    { ext: 'node', internal: 'nodeId', kind: 'node' },
    { ext: 'chapter', internal: 'nodeId', kind: 'node' },
    { ext: 'sourceChapter', internal: 'sourceNodeId', kind: 'node' },
    { ext: 'element', internal: 'elementId', kind: 'element' },
    { ext: 'storyline', internal: 'storylineId', kind: 'storyline' },
    { ext: 'category', internal: 'categoryId', kind: 'category' },
  ];
  for (const { ext, internal, kind } of map) {
    const raw = out[ext] ?? out[internal];
    if (typeof raw === 'string' && raw.trim()) out[internal] = resolveRef(ctx, kind, raw);
  }
  return out;
}

/** First non-empty string among `fields` on `args`. */
function firstRef(args: Record<string, unknown>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = args[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Resolve the prose entity a block tool targets, from a `kind` selector (node —
 * default — / element / storyline / category) + an `entity` NAME (or id). The
 * neutral `entity` arg is preferred; the legacy kind-specific spellings
 * (node/chapter/element/… and their pre-resolved *Id forms) are accepted for
 * back-compat. resolveRef is idempotent on ids, so re-resolving a resolved id is
 * a no-op.
 */
function resolveProseTarget(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): { entityType: ProseEntityType; id: string } {
  const rawKind = typeof args.kind === 'string' ? args.kind : 'node';
  const entityType = normalizeEntityKind(rawKind);
  if (!entityType) throw new Error(`unknown kind "${rawKind}" (use node | element | storyline | category)`);
  const ref = firstRef(args, [
    'entity', 'node', 'chapter', 'element', 'storyline', 'category',
    'nodeId', 'elementId', 'storylineId', 'categoryId',
  ]);
  if (!ref) throw new Error('missing entity reference (name or id)');
  return { entityType, id: resolveRef(ctx, entityType, ref) };
}

/** The entity descriptor a prose tool reports in its result. Keeps the legacy
 *  `node` key for chapters (byte-identical result); other kinds report
 *  `{entity, entityType}`. */
function proseEntityResult(entityType: ProseEntityType, id: string): Record<string, string> {
  const label = entityLabel(useDataStore.getState(), entityType, id);
  return entityType === 'node' ? { node: label } : { entity: label, entityType };
}

/**
 * The structural entities (elements / nodes / storylines …) a chapter references
 * in its prose, deduped by `${kind}:${id}`. Derived from the inline-mention
 * projection. Used by read_node's header.
 */
async function listChapterReferences(
  s: DataState,
  nodeId: string,
): Promise<Array<{ kind: string; id: string; label: string }>> {
  const mentions = await createInlineMentionRepository().listMentionsFromSource('node', nodeId);
  const seen = new Set<string>();
  const references: Array<{ kind: string; id: string; label: string }> = [];
  for (const m of mentions) {
    const key = `${m.toKind}:${m.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ kind: m.toKind, id: m.toId, label: entityLabel(s, m.toKind, m.toId) });
  }
  return references;
}

async function readChapter(ctx: AgentToolContext, nodeId: string, includeProse = true) {
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === nodeId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`No chapter/node found with id "${nodeId}"`);
  // Compact numbered rendering — the leading number is the handle for edit_block.
  const header = `${node.kind} "${node.title}" · ${node.writingStatus} · ${node.wordCount}字`;
  const summaryLine = `summary: ${node.summary || '(none)'}`;
  // Which elements/entities appear in this chapter (recorded inline mentions),
  // surfaced inline so the chapter's graph context rides along with its prose.
  const refs = await listChapterReferences(s, nodeId);
  // Names are project-unique, so list appearances by name+kind (no long ids).
  const appearsLine = refs.length
    ? `appears: ${refs.map((r) => `${r.label} (${r.kind})`).join(', ')}`
    : 'appears: (none recorded)';
  // Structural context inline (storylines + curated relations) so read_node is
  // self-sufficient — the agent knows what a chapter connects to before
  // reading/editing it (and prose:false yields just this header). Both are cheap
  // in-memory store reads; lines are omitted when empty (drifts stay identical).
  const storylineIds = s.nodeStorylineMapping[nodeId] ?? [];
  const storylineLine = storylineIds.length
    ? `storylines: ${storylineIds
        .map((sid) => {
          const name = entityLabel(s, 'storyline', sid);
          return s.primaryStorylineByNode[nodeId] === sid ? `${name} (primary)` : name;
        })
        .join(', ')}`
    : null;
  const rels = s.entityRelations.filter((r) => r.projectId === ctx.projectId);
  const relParts = [
    ...rels
      .filter((r) => r.fromKind === 'node' && r.fromId === nodeId)
      .map((r) => `${r.kind || 'related'} → ${entityLabel(s, r.toKind, r.toId)} (${r.toKind})`),
    ...rels
      .filter((r) => r.toKind === 'node' && r.toId === nodeId)
      .map((r) => `${entityLabel(s, r.fromKind, r.fromId)} (${r.fromKind}) → ${r.kind || 'related'}`),
  ];
  const relationsLine = relParts.length ? `relations: ${relParts.join(', ')}` : null;
  const head = [header, summaryLine, appearsLine, storylineLine, relationsLine]
    .filter(Boolean)
    .join('\n');
  // prose:false → header-only triage view; skip the (potentially expensive) live
  // Yjs read entirely. read_node(prose:false) replaces the old get_node_context.
  if (!includeProse) return head;
  // Read the live Yjs truth (what the editor shows), not just the contentJson
  // cache, so the numbering the agent edits against matches the open editor.
  const content = await createBookContentRepository().findByNodeId(nodeId);
  const truthJson = await getChapterContentJson(nodeId, content?.contentJson ?? null);
  const blocks = docToBlocks(truthJson);
  const body = blocks.length ? blocksToCompactText(blocks) : '(empty)';
  return `${head}\n\n${body}`;
}

/**
 * read_node, generalized over prose entities. A chapter/drift node keeps the
 * rich numbered view (header · summary · appears); element / storyline /
 * category get a body-only numbered view — they have no writingStatus / word
 * count / inline-mention projection, so emitting those lines would be misleading.
 */
async function readEntityBlocks(ctx: AgentToolContext, args: Record<string, unknown>) {
  const includeProse = args.prose !== false;
  const { entityType, id } = resolveProseTarget(ctx, args);
  if (entityType === 'node') return readChapter(ctx, id, includeProse);
  const label = entityLabel(useDataStore.getState(), entityType, id);
  // element/storyline/category bodies carry no header — prose:false leaves just
  // the label line (no graph context to surface like a chapter has).
  if (!includeProse) return `${entityType} "${label}"`;
  const truthJson = await getEntityContentJson(entityType, id);
  const blocks = docToBlocks(truthJson);
  const body = blocks.length ? blocksToCompactText(blocks) : '(empty)';
  return `${entityType} "${label}"\n\n${body}`;
}

async function readElement(ctx: AgentToolContext, elementId: string) {
  const s = useDataStore.getState();
  const el = s.bookElements.find((e) => e.id === elementId && e.projectId === ctx.projectId);
  if (!el) throw new Error(`No element found with id "${elementId}"`);
  // Read the live Yjs body (what the editor shows), not just the contentJson
  // cache, so the agent sees in-flight user edits — mirrors readChapter.
  const bodyJson = await getElementContentJson(elementId);
  // Patch count so the agent can discover an element HAS patches (list_elements /
  // read_element didn't surface this) and call get_element_patches for detail.
  // Excludes soft-deleted AND invalidated ones so it matches what
  // get_element_patches returns (both hide deleted-evidence patches).
  const del = pendingDeletedPatchIds(elementId);
  const patchCount = (await createElementPatchRepository().listByElement(elementId)).filter(
    (p) => !del.has(p.id) && !p.invalidatedAt,
  ).length;
  return {
    name: el.name,
    summary: el.summary,
    aliases: el.aliases,
    groupName: el.groupName,
    category: el.categoryId ? entityLabel(s, 'category', el.categoryId) : undefined,
    facts: parseKv(el.kvJson),
    patchCount,
    body: docToPlainText(bodyJson),
  };
}

function searchProject(ctx: AgentToolContext, query: string) {
  const q = query.trim().toLowerCase();
  // `label` is the project-unique name — pass it straight back as the entity
  // ref (no long id emitted).
  const matches: Array<{ kind: string; label: string }> = [];
  if (!q) return { matches };

  const s = useDataStore.getState();
  for (const n of s.bookNodes) {
    if (n.projectId !== ctx.projectId) continue;
    if (n.title.toLowerCase().includes(q)) matches.push({ kind: n.kind, label: n.title });
  }
  for (const e of s.bookElements) {
    if (e.projectId !== ctx.projectId) continue;
    const hay = [e.name, e.summary, ...e.aliases].join(' ').toLowerCase();
    if (hay.includes(q)) matches.push({ kind: 'element', label: e.name });
  }
  for (const sl of s.storylines) {
    if (sl.projectId !== ctx.projectId) continue;
    if (sl.name.toLowerCase().includes(q)) matches.push({ kind: 'storyline', label: sl.name });
  }
  return { matches };
}

// ---- Relational / context reads (point → surface) --------------------------
// These expose the projections the app already maintains (inline mentions,
// curated relations, storyline membership, rolling summaries, KV facts) so the
// agent can traverse the graph instead of brute-force reading every chapter.

type DataState = ReturnType<typeof useDataStore.getState>;

/** Resolve a (kind,id) to a human label from the in-memory store. */
function entityLabel(s: DataState, kind: string, id: string): string {
  switch (kind) {
    case 'node':
      return s.bookNodes.find((n) => n.id === id)?.title ?? id;
    case 'element':
      return s.bookElements.find((e) => e.id === id)?.name ?? id;
    case 'storyline':
      return s.storylines.find((sl) => sl.id === id)?.name ?? id;
    case 'category':
      return s.bookElementCategories.find((c) => c.id === id)?.name ?? id;
    default:
      return id;
  }
}

function snippetAround(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 40);
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}

/** The book's premise / goal / style facts + structure counts — the "面" anchor. */
function getProjectBrief(ctx: AgentToolContext) {
  const s = useDataStore.getState();
  const project = useProjectStore.getState().currentProject;
  const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
  return {
    name: project?.name ?? '',
    description: project?.summary ?? '',
    facts: project ? parseKv(project.kvJson) : [],
    counts: {
      chapters: nodes.filter(isChapter).length,
      drifts: nodes.filter((n) => n.kind === 'drift').length,
      storylines: s.storylines.filter((sl) => sl.projectId === ctx.projectId).length,
      elements: s.bookElements.filter((e) => e.projectId === ctx.projectId).length,
      categories: s.bookElementCategories.filter((c) => c.projectId === ctx.projectId).length,
    },
  };
}

/**
 * One-call orientation bundle: the project brief + the full node list (storylines
 * + chapters + drifts) + the full element list (categories + elements). Folds
 * what used to be get_project_brief → list_nodes → list_elements (three model
 * round-trips) into one, since the agent fetches all three to orient anyway. All
 * three are pure in-memory store reads, so bundling adds no extra work.
 */
function getOverview(ctx: AgentToolContext) {
  return {
    ...getProjectBrief(ctx),
    ...listChapters(ctx),
    ...listElements(ctx),
  };
}

/** A mention's surrounding text, centered on the match — enough for the agent
 *  to judge relevance without a follow-up read_block per blockId. */
const MENTION_SNIPPET_PAD = 36;
/** Cap on mention snippets returned per source; the rest are summarized as `more`
 *  so a heavily-mentioned entity doesn't flood the agent's context. */
const MENTIONS_PER_SOURCE = 4;

/** Count the spans recorded for one (block, target) row. Each span is one literal
 *  occurrence of the name in that block; falls back to 1 for legacy/empty json. */
function spanCount(spansJson: string): number {
  try {
    const spans = JSON.parse(spansJson);
    return Array.isArray(spans) && spans.length > 0 ? spans.length : 1;
  } catch {
    return 1;
  }
}

/** Build a context snippet for a mention: the block text windowed around the
 *  first span, with the matched name wrapped in 「」 and elided edges marked. */
function mentionSnippet(blockText: string, spansJson: string): string {
  if (!blockText) return '';
  let from = 0;
  let to = 0;
  try {
    const spans = JSON.parse(spansJson) as Array<{ from: number; to: number }>;
    if (Array.isArray(spans) && spans.length > 0) {
      from = Math.max(0, Math.min(spans[0].from ?? 0, blockText.length));
      to = Math.max(from, Math.min(spans[0].to ?? from, blockText.length));
    }
  } catch {
    /* no spans — fall back to the head of the block */
  }
  if (to === from) return blockText.slice(0, MENTION_SNIPPET_PAD * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, from - MENTION_SNIPPET_PAD);
  const end = Math.min(blockText.length, to + MENTION_SNIPPET_PAD);
  const lead = start > 0 ? '…' : '';
  const tail = end < blockText.length ? '…' : '';
  const out = `${lead}${blockText.slice(start, from)}「${blockText.slice(from, to)}」${blockText.slice(to, end)}${tail}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** Where a structural entity is mentioned in prose (its appearances/backlinks).
 *  Groups by source (surfaced by name, not id) and returns a short context
 *  snippet per mention so the agent can gauge relevance without re-reading each
 *  block. The blockId stays as the actionable handle for read_block / edits. */
async function whereDoesEntityAppear(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '');
  if (!isStructuralEntityKind(kind)) {
    throw new Error(`kind must be structural (node/element/storyline/category/patch), got "${kind}"`);
  }
  const ref = String(args.name ?? args.id ?? '');
  if (!ref) throw new Error('where_does_entity_appear requires name');
  const id = resolveByKind(ctx, kind, ref);
  const s = useDataStore.getState();
  const backlinks = await createInlineMentionRepository().listBacklinksToTarget(kind, id);

  // Group by source entity (one source can mention the target in many blocks).
  type SourceAgg = {
    fromKind: string;
    from: string;
    fromId: string;
    rows: Array<{ blockId: string; spansJson: string }>;
    mentionCount: number;
  };
  const bySource = new Map<string, SourceAgg>();
  for (const b of backlinks) {
    const key = `${b.fromKind}:${b.fromId}`;
    const cur =
      bySource.get(key) ??
      ({ fromKind: b.fromKind, from: b.fromTitle, fromId: b.fromId, rows: [], mentionCount: 0 } as SourceAgg);
    cur.rows.push({ blockId: b.fromBlockId, spansJson: b.fromSpansJson });
    cur.mentionCount += spanCount(b.fromSpansJson);
    bySource.set(key, cur);
  }

  // Read each prose source once to map blockId -> text for the snippets.
  type Appearance = {
    from: string;
    fromKind: string;
    mentionCount: number;
    mentions: Array<{ blockId: string; snippet: string }>;
    more?: number;
  };
  const appearances: Appearance[] = [];
  for (const src of bySource.values()) {
    const blockText = new Map<string, string>();
    if (isProseEntityType(src.fromKind)) {
      try {
        const json = await getEntityContentJson(src.fromKind, src.fromId);
        for (const blk of docToBlocks(json)) {
          if (blk.blockId) blockText.set(blk.blockId, blk.text);
        }
      } catch {
        /* content unreadable — fall back to blockId-only mentions */
      }
    }
    const mentions = src.rows.slice(0, MENTIONS_PER_SOURCE).map((r) => ({
      blockId: r.blockId,
      snippet: mentionSnippet(blockText.get(r.blockId) ?? '', r.spansJson),
    }));
    const more = src.rows.length - mentions.length;
    appearances.push({
      from: src.from,
      fromKind: src.fromKind,
      mentionCount: src.mentionCount,
      mentions,
      ...(more > 0 ? { more } : {}),
    });
  }
  // Heaviest sources first — where the entity actually lives.
  appearances.sort((a, b) => b.mentionCount - a.mentionCount);

  const totalMentions = appearances.reduce((n, a) => n + a.mentionCount, 0);
  return { target: { kind, name: entityLabel(s, kind, id) }, totalMentions, appearances };
}

/** The curated cross-entity relation edges touching an entity, both directions. */
function getEntityRelations(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '');
  const ref = String(args.name ?? args.id ?? '');
  if (!kind || !ref) throw new Error('get_entity_relations requires kind and name');
  const id = resolveByKind(ctx, kind, ref);
  const s = useDataStore.getState();
  const rels = s.entityRelations.filter((r) => r.projectId === ctx.projectId);
  // relationId stays — it's the opaque handle for remove_relation /
  // update_relation_kind (relations have no name). Endpoints are by name.
  const outgoing = rels
    .filter((r) => r.fromKind === kind && r.fromId === id)
    .map((r) => ({ relationId: r.id, relation: r.kind, toKind: r.toKind, to: entityLabel(s, r.toKind, r.toId) }));
  const incoming = rels
    .filter((r) => r.toKind === kind && r.toId === id)
    .map((r) => ({ relationId: r.id, relation: r.kind, fromKind: r.fromKind, from: entityLabel(s, r.fromKind, r.fromId) }));
  return { entity: { kind, name: entityLabel(s, kind, id) }, outgoing, incoming };
}

/** A storyline's facts plus its member chapters in reading order. */
function getStoryline(ctx: AgentToolContext, storylineId: string) {
  if (!storylineId) throw new Error('get_storyline requires storylineId');
  const s = useDataStore.getState();
  const sl = s.storylines.find((x) => x.id === storylineId && x.projectId === ctx.projectId);
  if (!sl) throw new Error(`No storyline found with id "${storylineId}"`);
  const nodeIds = s.storylineNodeMapping[storylineId] ?? [];
  const chapters = nodeIds
    .map((nid) => {
      const n = s.bookNodes.find((x) => x.id === nid);
      if (!n) return null;
      return {
        title: n.title,
        bookOrder: n.bookOrder,
        isPrimary: s.primaryStorylineByNode[nid] === storylineId,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.bookOrder ?? 0) - (b.bookOrder ?? 0));
  return { name: sl.name, summary: sl.summary, facts: parseKv(sl.kvJson), chapters };
}

/** Full-text search over chapter/drift prose and element bodies, with snippets. */
/**
 * The entity's CURRENT prose JSON for search — the live editor doc when one is
 * open (the contentJson cache lags the editor's debounce, so search would
 * otherwise miss in-flight text and report block numbers that disagree with
 * read_node), else the cheap cache. Gated on getLiveYDoc so closed entities skip
 * the Yjs rehydrate entirely.
 */
async function proseJsonForSearch(
  entityType: ProseEntityType,
  id: string,
  cacheJson: string,
): Promise<string> {
  return getLiveYDoc(proseDocId(entityType, id))
    ? getEntityContentJson(entityType, id, cacheJson)
    : cacheJson;
}

async function searchProse(ctx: AgentToolContext, args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  // title is the project-unique name — the agent passes it straight back as the
  // nodeId/elementId arg, so no long id is emitted here.
  const matches: Array<{ kind: string; title: string; block?: number; snippet: string }> = [];
  if (!q) return { matches };

  const s = useDataStore.getState();

  // Element bodies are in memory — cheap (live doc only when one is open).
  for (const e of s.bookElements) {
    if (e.projectId !== ctx.projectId) continue;
    const text = docToPlainText(await proseJsonForSearch('element', e.id, e.contentJson));
    const idx = text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      matches.push({ kind: 'element', title: e.name, snippet: snippetAround(text, idx, q.length) });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }

  // Chapter / drift prose — load per node (no FTS index exists).
  const contentRepo = createBookContentRepository();
  const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
  for (const n of nodes) {
    const content = await contentRepo.findByNodeId(n.id);
    if (!content) continue;
    const blocks = docToBlocks(await proseJsonForSearch('node', n.id, content.contentJson));
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const idx = b.text.toLowerCase().indexOf(q);
      if (idx !== -1) {
        matches.push({ kind: n.kind, title: n.title, block: i + 1, snippet: snippetAround(b.text, idx, q.length) });
        if (matches.length >= limit) return { matches, truncated: true };
        break; // one hit per chapter is enough for discovery — agent can read_node for the rest
      }
    }
  }
  return { matches };
}

/** An element's accepted state-change patches across chapters (its evolution). */
async function getElementPatches(_ctx: AgentToolContext, elementId: string) {
  if (!elementId) throw new Error('get_element_patches requires elementId');
  // Hide soft-deleted patches (delete_element_patch awaiting card confirmation) so
  // the agent's view matches its belief that it deleted them. Also hide invalidated
  // patches (anchored source text deleted) — deleted evidence isn't part of canon.
  const del = pendingDeletedPatchIds(elementId);
  const patches = (await createElementPatchRepository().listByElement(elementId)).filter(
    (p) => !del.has(p.id) && !p.invalidatedAt,
  );
  return {
    patches: patches.map((p) => ({
      patchId: p.id,
      title: p.title,
      sourceChapter: p.sourceNodeTitle,
      body: docToPlainText(p.contentJson),
      createdAt: p.createdAt,
    })),
  };
}

/** Editorial threads / Copilot suggestions attached to an entity (or all). */
function listComments(ctx: AgentToolContext, args: Record<string, unknown>) {
  // Canonicalize the scope kind (chapter/drift → node) and resolve a NAME → id,
  // so scoping behaves like the other tools.
  const rawKind = String(args.kind ?? '').trim();
  const scopeKind = rawKind ? normalizeEntityKind(rawKind) ?? rawKind : '';
  const rawId = String(args.entity ?? args.id ?? '').trim();
  const scopeId = rawId && rawKind ? resolveByKind(ctx, rawKind, rawId) : rawId;
  const onlyTodos = args.onlyTodos === true || args.onlyTodos === 'true';
  const statusFilter = typeof args.status === 'string' ? args.status.trim() : '';

  const s = useDataStore.getState();

  // Comment → entity relation edges (the right-sidebar TODO association). Build a
  // per-comment map once for the output, and the scope set via the shared helper
  // so it matches the editor's CommentRail exactly.
  const relByComment = new Map<string, Array<{ kind: string; id: string }>>();
  for (const r of s.entityRelations) {
    if (r.projectId === ctx.projectId && r.fromKind === 'comment') {
      const list = relByComment.get(r.fromId) ?? [];
      list.push({ kind: r.toKind, id: r.toId });
      relByComment.set(r.fromId, list);
    }
  }
  const relatedIds =
    scopeKind && scopeId
      ? commentIdsRelatedToEntity(
          s.entityRelations,
          ctx.projectId,
          scopeKind as Parameters<typeof commentIdsRelatedToEntity>[2],
          scopeId,
        )
      : new Set<string>();

  const rows = s.comments.filter((c) => {
    if (c.projectId !== ctx.projectId) return false;
    if (onlyTodos && c.kind !== 'todo') return false;
    if (statusFilter && c.status !== statusFilter) return false;
    // Scope (when a target is given): match the target_* columns OR a relation
    // edge pointing at the entity — so right-sidebar TODOs scope correctly too.
    if (scopeKind || scopeId) {
      const targetMatch =
        (!scopeKind || c.targetKind === scopeKind) && (!scopeId || c.targetId === scopeId);
      if (!targetMatch && !relatedIds.has(c.id)) return false;
    }
    return true;
  });

  return {
    comments: rows.map((c) => {
      // The text the note/TODO is anchored to, so the agent can locate it: the
      // block snapshot if anchored to a block, else the selected text. For a
      // block-anchored TODO, read_block(targetId, targetBlockId) gives the LIVE
      // text (the quote here is a creation-time snapshot and may be stale).
      const quote =
        getBlockSnapshotFromAnchor(c.anchorJson)?.blockText ||
        getSelectedTextFromAnchor(c.anchorJson) ||
        undefined;
      // Entities this comment is linked to via relation edges, by name — how a
      // floating TODO (no target_*) tells the agent which chapter it's about.
      const relatedTo = (relByComment.get(c.id) ?? []).map((e) => ({
        kind: e.kind,
        label: entityLabel(s, e.kind, e.id),
      }));
      return {
        // id is the commentId — the handle for set_comment_status / _kind / delete.
        id: c.id,
        kind: c.kind,
        targetKind: c.targetKind,
        // The anchored entity by name (not its uuid). targetBlockId stays a uuid
        // (blocks have no name) — read_block(node=target, blockId) reads it live.
        target: c.targetId ? entityLabel(s, c.targetKind ?? '', c.targetId) : undefined,
        targetBlockId: c.targetBlockId ?? undefined,
        relatedTo: relatedTo.length ? relatedTo : undefined,
        author: c.authorName ?? c.authorKind,
        status: c.status,
        body: docToPlainText(c.bodyJson),
        quote,
      };
    }),
  };
}

// ---- Write handlers --------------------------------------------------------
// All go through ctx.write (the usecases), so edits sync exactly like manual
// ones. Prose edits go through the chapter's Yjs document (see chapter-prose),
// so they apply live to an open editor instead of being clobbered by it.

async function updateElement(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.elementId ?? '');
  if (!id) throw new Error('update_element requires elementId');
  // Snapshot before-values so summary/kv edits can surface for review.
  const before = useDataStore.getState().bookElements.find((e) => e.id === id);
  const updates: UpdateElementUsecaseInput = {};
  if (typeof args.name === 'string') updates.name = args.name;
  if (typeof args.summary === 'string') updates.summary = args.summary;
  if (Array.isArray(args.aliases)) {
    updates.aliases = args.aliases.filter((a): a is string => typeof a === 'string');
  }
  if (typeof args.groupName === 'string') updates.groupName = args.groupName;
  // Re-categorize (element↔category relationship) + structured KV facts.
  if (typeof args.categoryId === 'string') updates.categoryId = args.categoryId;
  if (args.facts !== undefined) updates.kvJson = stringifyKv(toKvEntries(args.facts));
  await ctx.write.updateElement(id, updates);
  // Surface summary + kv edits for in-editor review (name/aliases/category stay
  // direct for now — the high-value canon fields are summary + facts).
  const changes: AgentBlockChange[] = [];
  if (updates.summary !== undefined) {
    const c = summaryFieldChange(before?.summary, updates.summary);
    if (c) changes.push(c);
  }
  if (updates.kvJson !== undefined) {
    changes.push(...kvFieldChanges('kv', before?.kvJson, updates.kvJson));
  }
  recordFieldChanges('element', id, changes);
  return { ok: true, element: entityLabel(useDataStore.getState(), 'element', id) };
}

async function createElement(ctx: AgentToolContext, args: Record<string, unknown>) {
  const categoryId = String(args.categoryId ?? '');
  if (!categoryId) throw new Error('create_element requires categoryId');
  const input: CreateBookElementInput = { categoryId };
  if (typeof args.name === 'string') input.name = args.name;
  if (typeof args.summary === 'string') input.summary = args.summary;
  if (Array.isArray(args.aliases)) {
    input.aliases = args.aliases.filter((a): a is string => typeof a === 'string');
  }
  const created = await ctx.write.createElement(input);
  // CreateBookElementInput has no kv field — set facts in a follow-up update.
  const createdId = (created as { id?: string })?.id;
  if (createdId && args.facts !== undefined) {
    await ctx.write.updateElement(createdId, { kvJson: stringifyKv(toKvEntries(args.facts)) });
  }
  // Return the actual (uniqueness-deduped) name, not the requested one.
  const name = createdId
    ? entityLabel(useDataStore.getState(), 'element', createdId)
    : (input.name ?? '');
  return { ok: true, element: name };
}

/**
 * Replace an element's body/profile prose wholesale. Elements expose their body
 * as a single plain-text blob (read_element has no block numbering), so the
 * agent rewrites the whole thing rather than block-addressing it. Goes through
 * the live Yjs doc (see writeElementProse) so an open element editor reflects it
 * immediately instead of clobbering it. Blank lines split paragraphs.
 */
async function setEntityBody(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  if (entityType === 'node') {
    throw new Error(
      'set_entity_body is for element / storyline / category bodies — use the block tools (edit_block / replace_block_range / insert_blocks) for chapter/drift prose so edits stay diffable',
    );
  }
  const paras = String(args.body ?? '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  await writeEntityProse(
    ctx,
    entityType,
    id,
    (frag) => yReplaceAllParagraphs(frag, paras),
    () =>
      JSON.stringify({
        type: 'doc',
        content: (paras.length ? paras : ['']).map(makeParagraphBlock),
      }),
  );
  return { ok: true, ...proseEntityResult(entityType, id) };
}

async function renameChapter(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const title = String(args.title ?? '');
  if (!nodeId || !title) throw new Error('rename_node requires node and title');
  await ctx.write.renameNode(nodeId, title);
  // The stored title may be uniqueness-deduped — report the actual one.
  return { ok: true, node: entityLabel(useDataStore.getState(), 'node', nodeId) };
}

async function setNodeSummary(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  if (!nodeId) throw new Error('set_node_summary requires node');
  await ctx.write.updateNode(nodeId, { summary: String(args.summary ?? '') });
  return { ok: true, node: entityLabel(useDataStore.getState(), 'node', nodeId) };
}

// Per-entity serialization for prose read-modify-write. Editing a block reads
// the whole doc, mutates it, and writes it all back; if two such ops on the SAME
// entity interleave (the model can fire parallel tool calls and the bridge runs
// them concurrently) the second write clobbers the first. We chain ops per
// prose docId (proseDocId(entityType,id)) so each one reads the previous one's
// persisted result — and so different entities never serialize against each other.
const contentWriteChains = new Map<string, Promise<unknown>>();
function withProseLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = contentWriteChains.get(lockKey) ?? Promise.resolve();
  // Run fn after the previous op settles (success OR failure — a prior error
  // must not wedge the chain).
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  // Stored tail swallows errors so the next waiter isn't rejected by this one.
  contentWriteChains.set(
    lockKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Normalize one block edit's target ({block} number or {blockId} uuid) + text. */
function parseBlockEdit(edit: {
  block?: unknown;
  blockId?: unknown;
  text?: unknown;
}): { target: { block?: number; blockId?: string }; text: string; label: string | number } {
  const text = String(edit.text ?? '');
  const hasBlockNum = edit.block !== undefined && edit.block !== null && edit.block !== '';
  if (hasBlockNum) {
    const idx = Number(edit.block);
    if (!Number.isInteger(idx) || idx < 1) {
      throw new Error('block must be a 1-based integer (the number from read_node)');
    }
    return { target: { block: idx }, text, label: idx };
  }
  const blockId = String(edit.blockId ?? '');
  if (!blockId) throw new Error('edit requires block (number) or blockId');
  return { target: { blockId }, text, label: blockId };
}

async function editBlock(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const { target, text, label } = parseBlockEdit(args);
  return withProseLock(proseDocId(entityType, id), async () => {
    const { blockIds } = await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => [yReplaceBlockText(frag, target, text)],
      (json) =>
        target.blockId
          ? replaceBlockText(json, target.blockId, text)
          : replaceBlockByIndex(json, target.block as number, text),
    );
    return { ok: true, ...proseEntityResult(entityType, id), block: label, blockIds };
  });
}

/**
 * Apply several block edits to one chapter atomically — a single transaction so
 * the edits can't clobber each other. Block numbers are stable within the batch
 * (edits only replace text, never add/remove blocks).
 */
async function editBlocks(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [];
  if (edits.length === 0) throw new Error('edit_blocks requires a non-empty edits array');
  const parsed = edits.map(parseBlockEdit);
  return withProseLock(proseDocId(entityType, id), async () => {
    const { blockIds } = await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => parsed.map((e) => yReplaceBlockText(frag, e.target, e.text)),
      (json) => {
        let j = json;
        for (const e of parsed) {
          j = e.target.blockId
            ? replaceBlockText(j, e.target.blockId, e.text)
            : replaceBlockByIndex(j, e.target.block as number, e.text);
        }
        return j;
      },
    );
    return {
      ok: true,
      ...proseEntityResult(entityType, id),
      edited: parsed.map((e) => e.label),
      blockIds,
    };
  });
}

async function appendParagraphTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const text = String(args.text ?? '');
  if (!text) throw new Error('append_paragraph requires text');
  const { entityType, id } = resolveProseTarget(ctx, args);
  return withProseLock(proseDocId(entityType, id), async () => {
    const { blockIds } = await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => [yAppendParagraph(frag, text)],
      (json) => appendParagraph(json, text),
    );
    return { ok: true, ...proseEntityResult(entityType, id), blockIds };
  });
}

// ---- structural block edits (add/remove blocks — id-addressed only) --------

async function readBlock(ctx: AgentToolContext, args: Record<string, unknown>) {
  const blockId = String(args.blockId ?? '');
  if (!blockId) throw new Error('read_block requires blockId');
  const { entityType, id } = resolveProseTarget(ctx, args);
  const truthJson = await getEntityContentJson(entityType, id);
  const blocks = docToBlocks(truthJson);
  const idx = blocks.findIndex((b) => b.blockId === blockId);
  if (idx < 0) return { blockId, found: false };
  const b = blocks[idx];
  return { blockId, found: true, block: idx + 1, type: b.type, text: b.text };
}

async function lookupBlock(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const ordinalRaw = args.ordinal;
  const ordinal =
    ordinalRaw === undefined || ordinalRaw === null || ordinalRaw === ''
      ? undefined
      : Number(ordinalRaw);
  const contains = args.contains === undefined ? undefined : String(args.contains);
  if (ordinal === undefined && !contains) {
    throw new Error('lookup_block requires ordinal and/or contains');
  }
  const truthJson = await getEntityContentJson(entityType, id);
  return {
    ...proseEntityResult(entityType, id),
    matches: findBlocks(truthJson, { ordinal, contains }),
  };
}

/** Map a 1-based block number (as shown by read_node) to its stable blockId in
 *  an already-loaded block list. Throws if out of range. */
function blockAtNumber(blocks: ReturnType<typeof docToBlocks>, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('block number must be a 1-based integer (the number from read_node)');
  }
  const b = blocks[n - 1];
  if (!b) throw new Error(`no block #${n} (entity has ${blocks.length} blocks)`);
  // The block exists at this ordinal but has no stable id — happens on prose
  // imported and never opened in the editor (block ids are stamped on first
  // open). Structural moves/removes need an id; give the agent a real recovery
  // path instead of a misleading "no block" so it doesn't retry the same number.
  if (!b.blockId) {
    throw new Error(
      `block #${n} has no stable id yet, so it can't be structurally removed/moved by number. ` +
        `Use edit_block to change its text (that works by number), or open the chapter once in the app to materialize block ids.`,
    );
  }
  return b.blockId;
}

/**
 * Resolve 1-based block NUMBERS to stable blockIds against the entity's CURRENT
 * doc (one read for the whole batch). Lets the structural tools take read_node
 * numbers directly — resolved at call time, before any mutation — so the agent
 * needn't call lookup_block first. blockId remains the safe handle when numbers
 * could shift (across multiple structural ops). Empty in → empty out (no read).
 */
async function blockNumbersToIds(
  entityType: ProseEntityType,
  id: string,
  ns: number[],
): Promise<string[]> {
  if (ns.length === 0) return [];
  const blocks = docToBlocks(await getEntityContentJson(entityType, id));
  return ns.map((n) => blockAtNumber(blocks, n));
}

async function removeBlocksTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const idArgs = Array.isArray(args.blockIds) ? args.blockIds.map((b) => String(b)) : [];
  const numArgs = Array.isArray(args.blockNumbers) ? args.blockNumbers.map((b) => Number(b)) : [];
  return withProseLock(proseDocId(entityType, id), async () => {
    // Resolve read_node numbers → blockIds up front (before any removal), so a
    // batch of numbers all map against the same pre-edit doc.
    const blockIds = [...idArgs, ...(await blockNumbersToIds(entityType, id, numArgs))];
    if (blockIds.length === 0) {
      throw new Error('remove_blocks requires blockIds (uuids) or blockNumbers (read_node numbers)');
    }
    await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => {
        yRemoveBlocks(frag, blockIds);
        return []; // removed blocks have no surviving anchor — tracked as structural
      },
      (json) => removeBlocks(json, blockIds),
    );
    return { ok: true, ...proseEntityResult(entityType, id), removed: blockIds };
  });
}

async function replaceBlockRangeTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const texts = Array.isArray(args.blocks) ? args.blocks.map((b) => String(b)) : [];
  return withProseLock(proseDocId(entityType, id), async () => {
    // Accept read_node NUMBERS (fromBlock/toBlock) as an alternative to uuids —
    // resolved against the current doc, one read for both sides.
    let fromBlockId = String(args.fromBlockId ?? '');
    let toBlockId = String(args.toBlockId ?? '');
    const nums: number[] = [];
    if (!fromBlockId && args.fromBlock != null && args.fromBlock !== '') nums.push(Number(args.fromBlock));
    if (!toBlockId && args.toBlock != null && args.toBlock !== '') nums.push(Number(args.toBlock));
    if (nums.length) {
      const ids = await blockNumbersToIds(entityType, id, nums);
      let k = 0;
      if (!fromBlockId && args.fromBlock != null && args.fromBlock !== '') fromBlockId = ids[k++];
      if (!toBlockId && args.toBlock != null && args.toBlock !== '') toBlockId = ids[k++];
    }
    if (!fromBlockId || !toBlockId) {
      throw new Error(
        'replace_block_range requires fromBlock/toBlock (read_node numbers) or fromBlockId/toBlockId (uuids)',
      );
    }
    const { blockIds } = await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => yReplaceBlockRange(frag, fromBlockId, toBlockId, texts),
      (json) => replaceBlockRange(json, fromBlockId, toBlockId, texts),
    );
    return {
      ok: true,
      ...proseEntityResult(entityType, id),
      replaced: { from: fromBlockId, to: toBlockId, with: texts.length },
      blockIds,
    };
  });
}

async function insertBlocksTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const texts = Array.isArray(args.blocks) ? args.blocks.map((b) => String(b)) : [];
  if (texts.length === 0) throw new Error('insert_blocks requires a non-empty blocks array');
  const { entityType, id } = resolveProseTarget(ctx, args);
  return withProseLock(proseDocId(entityType, id), async () => {
    // afterBlockId (uuid) or afterBlock (read_node number); omit both to prepend.
    let afterBlockId =
      args.afterBlockId === undefined || args.afterBlockId === null || args.afterBlockId === ''
        ? null
        : String(args.afterBlockId);
    if (!afterBlockId && args.afterBlock != null && args.afterBlock !== '') {
      afterBlockId = (await blockNumbersToIds(entityType, id, [Number(args.afterBlock)]))[0];
    }
    const { blockIds } = await writeEntityProse(
      ctx,
      entityType,
      id,
      (frag) => yInsertBlocks(frag, afterBlockId, texts),
      (json) => insertBlocks(json, afterBlockId, texts),
    );
    return {
      ok: true,
      ...proseEntityResult(entityType, id),
      inserted: texts.length,
      after: afterBlockId,
      blockIds,
    };
  });
}

// ---- Relationship handlers -------------------------------------------------

/**
 * Throw if a node is a drift — storyline membership / reading order are
 * chapter-only axes (see book-node.ts). Drifts are free-floating notes.
 */
function assertChapter(nodeId: string): void {
  const node = useDataStore.getState().bookNodes.find((n) => n.id === nodeId);
  if (node && node.kind !== 'chapter') {
    throw new Error(
      `"${node.title}" is a drift, not a chapter — only chapters can belong to a storyline`,
    );
  }
}

async function linkChapterToStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires chapter and storyline');
  assertChapter(nodeId);
  await ctx.write.addNodeToStoryline(nodeId, storylineId);
  const s = useDataStore.getState();
  return { ok: true, chapter: entityLabel(s, 'node', nodeId), storyline: entityLabel(s, 'storyline', storylineId) };
}

async function unlinkChapterFromStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires chapter and storyline');
  assertChapter(nodeId);
  await ctx.write.removeNodeFromStoryline(nodeId, storylineId);
  const s = useDataStore.getState();
  return { ok: true, chapter: entityLabel(s, 'node', nodeId), storyline: entityLabel(s, 'storyline', storylineId) };
}

async function setPrimaryStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires chapter and storyline');
  assertChapter(nodeId);
  // Ensure membership, then mark it primary — setNodeStorylines replaces the
  // full set, so include the current memberships plus this one.
  const current = useDataStore.getState().nodeStorylineMapping[nodeId] ?? [];
  const ids = current.includes(storylineId) ? current : [...current, storylineId];
  await ctx.write.setNodeStorylines(nodeId, ids, { primaryStorylineId: storylineId });
  const s = useDataStore.getState();
  return {
    ok: true,
    chapter: entityLabel(s, 'node', nodeId),
    primaryStoryline: entityLabel(s, 'storyline', storylineId),
  };
}

async function addRelation(ctx: AgentToolContext, args: Record<string, unknown>) {
  const fromKind = String(args.fromKind ?? '');
  const fromRef = String(args.from ?? args.fromId ?? '');
  const toKind = String(args.toKind ?? '');
  const toRef = String(args.to ?? args.toId ?? '');
  if (!isEntityKind(fromKind)) throw new Error(`Invalid fromKind "${fromKind}"`);
  if (!isStructuralEntityKind(toKind)) {
    throw new Error(`Invalid toKind "${toKind}" (must be node/element/patch/category/storyline)`);
  }
  if (!fromRef || !toRef) throw new Error('add_relation requires from and to');
  const resolvedFrom = resolveByKind(ctx, fromKind, fromRef);
  const resolvedTo = resolveByKind(ctx, toKind, toRef);
  const kind = typeof args.kind === 'string' ? args.kind : undefined;
  const relation = await ctx.write.addRelation(fromKind, resolvedFrom, toKind, resolvedTo, { kind });
  const s = useDataStore.getState();
  // relationId is the handle for remove_relation / update_relation_kind.
  return {
    ok: true,
    relationId: (relation as { id?: string })?.id,
    from: entityLabel(s, fromKind, resolvedFrom),
    to: entityLabel(s, toKind, resolvedTo),
    relation: kind,
  };
}

async function removeRelation(ctx: AgentToolContext, args: Record<string, unknown>) {
  const relationId = String(args.relationId ?? '');
  if (!relationId) throw new Error('remove_relation requires relationId (from get_entity_relations)');
  if (!(await requestAgentConfirm('Agent 想删除一条实体关系。允许吗？'))) {
    return { ok: false, declined: true };
  }
  await ctx.write.removeRelation(relationId);
  return { ok: true, relationId };
}

async function updateRelationKind(ctx: AgentToolContext, args: Record<string, unknown>) {
  const relationId = String(args.relationId ?? '');
  if (!relationId) throw new Error('update_relation_kind requires relationId');
  const kind = typeof args.kind === 'string' ? args.kind : null;
  await ctx.write.updateRelationKind(relationId, kind);
  return { ok: true, relationId, kind };
}

async function createStorylineTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const input: CreateStorylineInput = {};
  if (typeof args.name === 'string') input.name = args.name;
  if (typeof args.summary === 'string') input.summary = args.summary;
  const created = await ctx.write.createStoryline(input);
  const id = (created as { id?: string })?.id;
  return {
    ok: true,
    storyline: id ? entityLabel(useDataStore.getState(), 'storyline', id) : (input.name ?? ''),
  };
}

async function updateStorylineTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.storylineId ?? '');
  if (!id) throw new Error('update_storyline requires storyline');
  const before = useDataStore.getState().storylines.find((s) => s.id === id);
  const input: UpdateStorylineInput = { id };
  if (typeof args.name === 'string') input.name = args.name;
  if (typeof args.summary === 'string') input.summary = args.summary;
  if (args.facts !== undefined) {
    input.kvJson = mergeKv(before?.kvJson, toKvEntries(args.facts));
  }
  await ctx.write.updateStoryline(input);
  const changes: AgentBlockChange[] = [];
  if (input.summary !== undefined) {
    const c = summaryFieldChange(before?.summary, input.summary);
    if (c) changes.push(c);
  }
  if (input.kvJson !== undefined) {
    changes.push(...kvFieldChanges('kv', before?.kvJson, input.kvJson));
  }
  recordFieldChanges('storyline', id, changes);
  return { ok: true, storyline: entityLabel(useDataStore.getState(), 'storyline', id) };
}

async function createCategoryTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const input: CreateElementCategoryInput = {};
  if (typeof args.name === 'string') input.name = args.name;
  const created = await ctx.write.createCategory(input);
  const id = (created as { id?: string })?.id;
  return {
    ok: true,
    category: id ? entityLabel(useDataStore.getState(), 'category', id) : (input.name ?? ''),
  };
}

/** Set/update the project's KV facts (merge by key — preserves the author's other facts). */
async function updateProjectFacts(ctx: AgentToolContext, args: Record<string, unknown>) {
  const project = useProjectStore.getState().currentProject;
  if (!project || project.id !== ctx.projectId) throw new Error('No current project to update');
  const facts = toKvEntries(args.facts);
  if (facts.length === 0) throw new Error('update_project_facts requires a non-empty facts array');
  const kvJson = mergeKv(project.kvJson, facts);
  await ctx.write.updateProject(project.id, { kvJson });
  return { ok: true, facts: parseKv(kvJson) };
}

/**
 * Set/update a category's element TEMPLATE facts (elementTemplateKvJson) — the
 * kv seeded into new elements of that category, NOT the category's own metadata.
 */
async function updateCategoryTemplate(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.categoryId ?? '');
  if (!id) throw new Error('update_category requires categoryId');
  const facts = toKvEntries(args.templateFacts);
  if (facts.length === 0) throw new Error('update_category requires a non-empty templateFacts array');
  const cat = useDataStore.getState().bookElementCategories.find((c) => c.id === id);
  if (!cat || cat.projectId !== ctx.projectId) throw new Error(`No category found with id "${id}"`);
  const elementTemplateKvJson = mergeKv(cat.elementTemplateKvJson, facts);
  await ctx.write.updateCategory(id, { elementTemplateKvJson });
  recordFieldChanges(
    'category',
    id,
    kvFieldChanges('templatekv', cat.elementTemplateKvJson, elementTemplateKvJson),
  );
  return {
    ok: true,
    category: entityLabel(useDataStore.getState(), 'category', id),
    templateFacts: parseKv(elementTemplateKvJson),
  };
}

async function createNodeTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = args.kind === 'chapter' ? 'chapter' : args.kind === 'drift' ? 'drift' : null;
  if (!kind) throw new Error("create_node requires kind: 'chapter' or 'drift'");
  const input: CreateNodeUsecaseInput = { kind };
  if (typeof args.title === 'string') input.title = args.title;
  if (kind === 'chapter') {
    if (typeof args.storylineId === 'string') input.mainStorylineId = args.storylineId;
    // Chapters sit on the reading axis — append after the current last chapter.
    const s = useDataStore.getState();
    const maxOrder = s.bookNodes
      .filter((n) => n.projectId === ctx.projectId && n.kind === 'chapter')
      .reduce((max, n) => Math.max(max, n.bookOrder ?? 0), 0);
    input.bookOrder = maxOrder + 1;
  }
  const created = await ctx.write.createNode(input);
  const id = (created as { id?: string })?.id;
  return {
    ok: true,
    node: id ? entityLabel(useDataStore.getState(), 'node', id) : (input.title ?? ''),
    kind,
  };
}

async function deleteElement(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.elementId ?? '');
  if (!id) throw new Error('delete_element requires elementId');
  const el = useDataStore.getState().bookElements.find((e) => e.id === id);
  const label = el ? el.name : id;
  // Destructive — require explicit human confirmation (non-blocking, auto-declines
  // before the bridge timeout so a delete can't run after the agent is told it failed).
  if (!(await requestAgentConfirm(`Agent 想删除元素「${label}」。允许吗？`))) {
    return { ok: false, declined: true };
  }
  await ctx.write.removeElement(id);
  return { ok: true, element: label };
}

// ---- Summary (reverse-generate: read elsewhere, write here) ----------------

async function setSummary(ctx: AgentToolContext, args: Record<string, unknown>) {
  const targetKind = String(args.targetKind ?? '');
  const summary = String(args.summary ?? '');
  const ref = String(args.target ?? args.targetId ?? '');
  if (!ref) throw new Error('set_summary requires target');
  const targetId = resolveByKind(ctx, targetKind, ref);
  const ds = useDataStore.getState();
  let entityType: ActivityEntityType | null = null;
  let beforeSummary = '';
  switch (targetKind) {
    case 'node':
    case 'chapter':
    case 'drift':
      entityType = 'node';
      beforeSummary = ds.bookNodes.find((n) => n.id === targetId)?.summary ?? '';
      await ctx.write.updateNode(targetId, { summary });
      break;
    case 'element':
      entityType = 'element';
      beforeSummary = ds.bookElements.find((e) => e.id === targetId)?.summary ?? '';
      await ctx.write.updateElement(targetId, { summary });
      break;
    case 'storyline':
      entityType = 'storyline';
      beforeSummary = ds.storylines.find((s) => s.id === targetId)?.summary ?? '';
      await ctx.write.updateStoryline({ id: targetId, summary });
      break;
    default:
      throw new Error(`set_summary targetKind must be node/element/storyline, got "${targetKind}"`);
  }
  if (entityType) {
    const c = summaryFieldChange(beforeSummary, summary);
    if (c) recordFieldChanges(entityType, targetId, [c]);
  }
  const nk = normalizeEntityKind(targetKind) ?? targetKind;
  return { ok: true, targetKind, target: entityLabel(useDataStore.getState(), nk, targetId) };
}

// ---- Element patches (direct repo + sync, mirroring the app's UI path) ------

/** Sync payload shape shared by patch create/update (mirrors PatchesSection). */
function patchSyncPayload(p: {
  id: string;
  elementId: string;
  sourceNodeId: string | null;
  sourceBlockId: string | null;
  sourceBlockText: string | null;
  textAnchorJson: string | null;
  invalidatedAt: string | null;
  title: string | null;
  contentJson: string;
  orderKey: number;
}): Record<string, unknown> {
  return {
    id: p.id,
    elementId: p.elementId,
    sourceNodeId: p.sourceNodeId,
    sourceBlockId: p.sourceBlockId,
    sourceBlockText: p.sourceBlockText,
    textAnchorJson: p.textAnchorJson,
    invalidatedAt: p.invalidatedAt,
    title: p.title,
    contentJson: p.contentJson,
    orderKey: p.orderKey,
  };
}

async function createElementPatch(ctx: AgentToolContext, args: Record<string, unknown>) {
  const elementId = String(args.elementId ?? '');
  if (!elementId) throw new Error('create_element_patch requires elementId');
  const input: CreatePatchInput = { projectId: ctx.projectId, elementId };
  if (typeof args.title === 'string') input.title = args.title;
  if (typeof args.body === 'string' && args.body.trim()) {
    input.contentJson = createPlainCommentDoc(args.body);
  }
  // sourceChapter (a node NAME) was resolved to sourceNodeId by resolveArgsRefs.
  if (typeof args.sourceNodeId === 'string') input.sourceNodeId = args.sourceNodeId;
  const created = await createElementPatchRepository().create(input);
  syncElementPatchCreate(created.id, ctx.projectId, patchSyncPayload(created));
  // Surface the new patch for card-level review (keep / discard) — soft-approval,
  // same as the other non-prose edits. Marks `patch:<id>` pending on the element.
  recordFieldChanges('element', elementId, [patchFieldChange(created.id, created.title)]);
  // Tell the open element editor's PatchesSection to reload (it has no store
  // subscription — it only refreshes on its own actions + this event).
  eventBus.emit('element:patches-changed', { elementId });
  // patchId is the handle for update_element_patch / delete_element_patch.
  return {
    ok: true,
    patchId: created.id,
    element: entityLabel(useDataStore.getState(), 'element', elementId),
    title: created.title,
  };
}

async function updateElementPatch(ctx: AgentToolContext, args: Record<string, unknown>) {
  const patchId = String(args.patchId ?? '');
  if (!patchId) throw new Error('update_element_patch requires patchId');
  const before = await createElementPatchRepository().findById(patchId);
  if (!before) throw new Error(`No patch found with id "${patchId}"`);
  const updates: UpdatePatchInput = {};
  if (typeof args.title === 'string') updates.title = args.title;
  if (typeof args.body === 'string') updates.contentJson = createPlainCommentDoc(args.body);
  const updated = await createElementPatchRepository().update(patchId, updates);
  if (!updated) throw new Error(`No patch found with id "${patchId}"`);
  syncElementPatchUpdate(updated.id, ctx.projectId, patchSyncPayload(updated));
  // Surface the edit for review — op 'changed', stashing the pre-edit title +
  // body in oldText so ✗ can restore them; the card renders a title/body diff.
  if (updates.title !== undefined || updates.contentJson !== undefined) {
    const stash = JSON.stringify({ title: before.title, contentJson: before.contentJson });
    const label = updated.title?.trim() ? updated.title : '补丁';
    recordFieldChanges('element', updated.elementId, [
      {
        blockId: fieldBlockId('patch', patchId),
        op: 'changed',
        oldText: stash,
        newText: '',
        afterPrevId: null,
        field: { kind: 'patch', key: patchId, label },
      },
    ]);
  }
  eventBus.emit('element:patches-changed', { elementId: updated.elementId });
  return {
    ok: true,
    patchId,
    element: entityLabel(useDataStore.getState(), 'element', updated.elementId),
  };
}

async function deleteElementPatch(_ctx: AgentToolContext, args: Record<string, unknown>) {
  const patchId = String(args.patchId ?? '');
  if (!patchId) throw new Error('delete_element_patch requires patchId');
  const existing = await createElementPatchRepository().findById(patchId);
  if (!existing) return { ok: true, patchId }; // already gone
  // SOFT delete: a patch is a minor sub-field, so route through the in-editor
  // approve flow instead of a blocking confirm. The row stays until the user
  // confirms on the card (get_element_patches hides it meanwhile, so the agent's
  // reads match its belief that it's deleted); ✗ keeps it + tells the agent.
  // (Heavier deletes — element / chapter — still use requestAgentConfirm. TODO:
  // move THAT off the full-screen overlay into a non-blocking in-chat prompt that
  // flashes the agent tab while it blocks — see agent-confirm-store.)
  const title = existing.title?.trim() ? existing.title : '补丁';
  recordFieldChanges('element', existing.elementId, [
    {
      blockId: fieldBlockId('patch', patchId),
      op: 'deleted',
      oldText: '',
      newText: '',
      afterPrevId: null,
      field: { kind: 'patch', key: patchId, label: title },
    },
  ]);
  // Reload any open PatchesSection so the card picks up the pending-delete mark.
  eventBus.emit('element:patches-changed', { elementId: existing.elementId });
  return {
    ok: true,
    patchId,
    element: entityLabel(useDataStore.getState(), 'element', existing.elementId),
  };
}

// ---- Comments / TODOs (a TODO is a comment with kind='todo') ----------------

async function createComment(ctx: AgentToolContext, args: Record<string, unknown>) {
  const body = String(args.body ?? '').trim();
  if (!body) throw new Error('create_comment requires body');
  const input: CreateCommentInput = {
    kind: args.kind === 'todo' ? 'todo' : args.kind === 'exception' ? 'exception' : 'note',
    bodyJson: createPlainCommentDoc(body),
  };
  // Unlike the *Id args, targetKind/targetId aren't touched by resolveArgsRefs,
  // so resolve them here: the agent passes entity NAMES everywhere else, and the
  // editor/rail filter by the canonical kind ('node', not 'chapter') + the real
  // id. Without this the comment "saves" but anchors to a name string that
  // matches no entity, so it never surfaces. (Reported: agent comments not
  // associating to their entity.)
  // The agent passes the entity NAME via `target` (legacy `targetId` accepted).
  const targetRef =
    (typeof args.target === 'string' && args.target.trim()) ||
    (typeof args.targetId === 'string' && args.targetId.trim()) ||
    '';
  if (typeof args.targetKind === 'string' && args.targetKind.trim()) {
    const rawKind = args.targetKind.trim();
    // normalizeEntityKind maps chapter/drift→node; unknown kinds (e.g. 'patch')
    // pass through unchanged, matching CommentTargetKind.
    input.targetKind = (normalizeEntityKind(rawKind) ?? rawKind) as CreateCommentInput['targetKind'];
    if (targetRef) input.targetId = resolveByKind(ctx, rawKind, targetRef);
  } else if (targetRef) {
    // No kind to resolve against — store the ref verbatim.
    input.targetId = targetRef;
  }
  if (typeof args.targetBlockId === 'string' && args.targetBlockId.trim()) {
    input.targetBlockId = args.targetBlockId.trim();
  }
  const created = await ctx.write.createComment(input);
  return { ok: true, commentId: (created as { id?: string })?.id };
}

async function deleteCommentTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.commentId ?? '');
  if (!id) throw new Error('delete_comment requires commentId');
  if (!(await requestAgentConfirm('Agent 想删除一条批注 / TODO。允许吗？'))) {
    return { ok: false, declined: true };
  }
  await ctx.write.deleteComment(id);
  return { ok: true, commentId: id };
}

async function setCommentStatus(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.commentId ?? '');
  const status = String(args.status ?? '');
  if (!id) throw new Error('set_comment_status requires commentId');
  if (status === 'resolved') await ctx.write.resolveComment(id);
  else if (status === 'open') await ctx.write.reopenComment(id);
  else throw new Error(`status must be 'resolved' or 'open', got "${status}"`);
  return { ok: true, commentId: id, status };
}

async function setCommentKind(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.commentId ?? '');
  const kind = String(args.kind ?? '');
  if (!id) throw new Error('set_comment_kind requires commentId');
  if (kind === 'todo') await ctx.write.convertToTodo(id);
  else if (kind === 'note') await ctx.write.revertToNote(id);
  else if (kind === 'exception') await ctx.write.setCommentKind(id, 'exception');
  else throw new Error(`kind must be 'todo', 'note' or 'exception', got "${kind}"`);
  return { ok: true, commentId: id, kind };
}

// ---- agent memory (author-level standing guidance) -------------------------
// `remember` writes straight to 'active' (no confirm — saving a memory is cheap
// and reversible; the author manages/deletes them in 设置 → General Agent or the
// composer 记忆 menu). Only `forget` blocks on requestAgentConfirm, since a
// delete is the one destructive memory action.

function coerceMemoryKind(raw: unknown): AgentMemoryKind {
  return raw === 'veto' ? 'veto' : raw === 'directive' ? 'directive' : 'preference';
}

async function rememberTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const body = String(args.body ?? '').trim();
  if (!body) throw new Error('remember requires body');
  const kind = coerceMemoryKind(args.kind);

  // Optional anchor: the agent passes an entity NAME; resolve it to a real id +
  // canonical kind, mirroring create_comment.
  let targetKind: StructuralEntityKind | null = null;
  let targetId: string | null = null;
  const targetRef = typeof args.target === 'string' ? args.target.trim() : '';
  if (targetRef && typeof args.targetKind === 'string' && args.targetKind.trim()) {
    const rawKind = args.targetKind.trim();
    const norm = (normalizeEntityKind(rawKind) ?? rawKind) as string;
    if (isStructuralEntityKind(norm)) {
      targetKind = norm;
      targetId = resolveByKind(ctx, rawKind, targetRef);
    }
  }

  const supersedesId =
    typeof args.supersedes === 'string' && args.supersedes.trim()
      ? args.supersedes.trim()
      : null;

  // Write straight to 'active' — no confirm; the author manages/deletes memories
  // in settings or the composer 记忆 menu.
  const created = await createMemory(ctx.projectId, {
    kind,
    body,
    source: 'agent',
    status: 'active',
    targetKind,
    targetId,
    supersedesId,
  });
  // Evolution: retire the memory this one replaces so it stops steering.
  if (supersedesId) await setMemoryStatus(ctx.projectId, supersedesId, 'dismissed');

  return { ok: true, memoryId: created.id };
}

async function listMemoryTool(ctx: AgentToolContext, _args: Record<string, unknown>) {
  const rows = await listLiveMemories(ctx.projectId);
  const s = useDataStore.getState();
  return {
    memories: rows
      .filter((m) => m.status !== 'dismissed')
      .map((m) => ({
        memoryId: m.id,
        kind: m.kind,
        status: m.status,
        body: m.body,
        target:
          m.targetKind && m.targetId
            ? (entityLabel(s, m.targetKind, m.targetId) ?? m.targetId)
            : undefined,
      })),
  };
}

async function forgetTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.memoryId ?? '');
  if (!id) throw new Error('forget requires memoryId');
  if (!(await requestAgentConfirm('Agent 想删除一条记忆。允许吗？'))) {
    return { ok: false, declined: true };
  }
  await softDeleteMemory(ctx.projectId, id);
  return { ok: true, memoryId: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow review bridge handlers. The main-process LangGraph engine calls these
// over the agent bridge (callRenderer) to read the locked chapter + rules, judge
// semantic assertions, write shadow comments, and push the chapter's status.
// They reuse this file's private helpers (the renderer owns the DB + Yjs prose).

// Chapter-scoped tool-result cache. Across a single review the per-rule FC loops
// re-request the same canon (get_project_brief, list_elements, read_element …);
// memoize by (tool, args) so duplicate fetches collapse to one. Reset per review
// (cleared when the chapter snapshot is read at the start of `gather`) and freed
// when status is pushed at the end. Read-only tools only → caching is always safe.
const shadowToolCache = new Map<string, Map<string, string>>();

function shadowCacheKey(name: string, args: Record<string, unknown>): string {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) norm[k] = args[k];
  return `${name}:${JSON.stringify(norm)}`;
}

// Per-review record of the canon entities the judge ACTUALLY consulted (resolved
// from its read-tool calls). The precise `(chapter)→entities` dependency edges —
// compiler `-MMD` to the inline-mention `grep #include`. Reset per review at the
// snapshot, harvested + persisted at shadow_set_status. Captured for OBSERVATION
// only right now (staleness still derives from mentions — no behavior change).
const shadowConsultedByChapter = new Map<string, Map<string, ShadowConsultedRef>>();

// Which specific canon entity (if any) a read-tool call consulted. Only the tools
// that read ONE named entity's content count — broad discovery/scan calls
// (search_*, list_*, get_project_brief, where_does_entity_appear) are deliberately
// excluded: they aren't a dependency on a particular entity, so folding them in
// would re-inflate the edge set back toward mention-level noise.
function consultedRefFor(
  ctx: AgentToolContext,
  name: string,
  cleanArgs: Record<string, unknown>,
): ShadowConsultedRef | null {
  try {
    let kind: ShadowConsultedKind;
    let id: string;
    if (name === 'read_node') {
      const t = resolveProseTarget(ctx, cleanArgs);
      kind = t.entityType;
      id = t.id;
    } else if (name === 'read_element' || name === 'get_element_patches') {
      kind = 'element';
      id = resolveRef(ctx, 'element', String(cleanArgs.element ?? cleanArgs.elementId ?? ''));
    } else if (name === 'get_storyline') {
      kind = 'storyline';
      id = resolveRef(ctx, 'storyline', String(cleanArgs.storyline ?? cleanArgs.storylineId ?? ''));
    } else {
      return null;
    }
    if (!id) return null;
    return { kind, id, label: entityLabel(useDataStore.getState(), kind, id) };
  } catch {
    return null; // unresolvable (hallucinated name) — the tool itself already errored
  }
}

function recordShadowConsulted(chapterId: string, ref: ShadowConsultedRef): void {
  // The chapter is its own trivially-true dependency (reading the chapter under
  // review isn't an external edge) — skip it so a self-read never marks it stale.
  if (ref.kind === 'node' && ref.id === chapterId) return;
  const map = shadowConsultedByChapter.get(chapterId);
  if (!map) return; // no active review window (reset happens at the snapshot)
  map.set(`${ref.kind}:${ref.id}`, ref);
}

/** Harvest + clear the entities consulted during this chapter's review. */
export function takeShadowConsulted(chapterId: string): ShadowConsultedRef[] {
  const map = shadowConsultedByChapter.get(chapterId);
  if (!map) return [];
  shadowConsultedByChapter.delete(chapterId);
  return [...map.values()];
}

// Schema-allowed arg names per read tool. Used to STRIP args the model invents
// (e.g. read_node pagination `read_node 11 1 60` — which both no-ops AND defeats
// the cache by varying the key) so repeated reads dedupe; and as the allowlist.
const READ_TOOL_ARG_KEYS = new Map<string, Set<string>>(
  AGENT_READ_TOOLS.map((t) => {
    const props = (t.parametersSchema as { properties?: Record<string, unknown> }).properties ?? {};
    return [t.name, new Set(Object.keys(props))] as const;
  }),
);
// A compact menu handed back when the model calls a tool that doesn't exist, so it
// self-corrects in ONE round instead of guessing read_drift→get_all_drifts→…
const READ_TOOL_MENU = AGENT_READ_TOOLS.map(
  (t) => `${t.name}(${[...(READ_TOOL_ARG_KEYS.get(t.name) ?? [])].join(', ')})`,
).join('；');

// One READ tool executor for the shadow judge. Guards: cancel check + read-only
// allowlist (the judge must never reach a write tool — advise-not-block), arg
// stripping, and the per-review cache. Disallowed/hallucinated tools don't throw —
// they return the real menu so the model corrects course instead of burning rounds.
// Effective-canon patch reader for Shadow: returns the element's evolution patches that
// are IN EFFECT for the chapter under review — whose source chapter is at/before this
// chapter on the timeline (narrativeOrder ?? bookOrder). Later-chapter patches must NOT
// excuse an earlier divergence, so they're withheld (only their count is noted). This
// realizes effective_canon(element, N) = canon + patches up to N (see shadow/DESIGN.md).
async function shadowEffectivePatchesText(
  ctx: AgentToolContext,
  chapterId: string,
  args: Record<string, unknown>,
): Promise<ToolRunOutcome> {
  const ref = String(args.element ?? args.elementId ?? args.node ?? '').trim();
  const elementId = resolveRef(ctx, 'element', ref);
  if (!elementId) return { content: `（eval：无设定「${ref}」）`, status: 'denied', note: '未知设定' };

  // This chapter's timeline position. A node resolves to its narrativeOrder when the
  // author set one (story-time, handles flashbacks), else bookOrder (reading order).
  const timelineKey = (n?: { narrativeOrder: number | null; bookOrder: number | null }): number =>
    n ? (n.narrativeOrder ?? n.bookOrder ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const here = useDataStore.getState().bookNodes.find((n) => n.id === chapterId);
  const cutoff = timelineKey(here);

  const del = pendingDeletedPatchIds(elementId);
  const all = (await createElementPatchRepository().listByElement(elementId)).filter(
    // Drop soft-deleted patches AND invalidated ones: a patch whose anchored
    // source text was deleted from its chapter (invalidatedAt set) no longer has
    // standing evidence, so it can't sanction a divergence — exclude it entirely
    // (not even counted as a "future" patch) from this chapter's effective canon.
    (p) => !del.has(p.id) && !p.invalidatedAt,
  );
  // Floating patches (no chapter anchor) are global authored evolutions → always in effect.
  const orderOfPatch = (p: PatchWithSourceTitle): number =>
    p.sourceNarrativeOrder ?? p.sourceBookOrder ?? Number.NEGATIVE_INFINITY;
  const inEffect = all.filter((p) => orderOfPatch(p) <= cutoff);
  const future = all.length - inEffect.length;

  if (!inEffect.length) {
    return {
      content: future
        ? `设定「${ref}」有 ${future} 条演化记录(patch)，但都来自更晚的章节，对本章【尚未生效】——不可用于解释本章的偏离。`
        : `设定「${ref}」无演化记录(patch)。若本章正文与其当前设定冲突，又无对应演化背书，即为真实矛盾，应报出。`,
      status: 'ok',
    };
  }

  const lines = inEffect.map((p) => {
    const where = p.sourceNodeTitle ? `（《${p.sourceNodeTitle}》起生效）` : '（全局生效）';
    return `· ${p.title ?? '(无标题)'}${where}：${truncate(docToPlainText(p.contentJson), 400)}`;
  });
  const tail = future
    ? `\n（另有 ${future} 条来自更晚章节的演化，对本章尚未生效，已隐去——不可用于解释本章）`
    : '';
  return {
    content:
      `设定「${ref}」对本章【已生效】的演化记录(patch)。正文与其设定的偏离，只有被下列之一解释才算合法演化，否则按矛盾报出：\n` +
      lines.join('\n') +
      tail,
    status: 'ok',
  };
}

function makeShadowRunTool(ctx: AgentToolContext, chapterId: string) {
  return async (name: string, toolArgs: Record<string, unknown>): Promise<ToolRunOutcome> => {
    throwIfShadowCancelled(chapterId);
    const allowedKeys = READ_TOOL_ARG_KEYS.get(name);
    if (!allowedKeys) {
      return {
        content: `没有名为「${name}」的工具。只读工具仅限：${READ_TOOL_MENU}。读 drift/设定/元素/故事线正文请用 read_node(node=名称, kind='drift'|'element'|'storyline'|'category')；本章正文你已在上文按段拿到，无需再读本章自身。`,
        status: 'denied',
        note: '未知工具',
      };
    }
    // Drop args outside the schema (the model invents read_node pagination etc.).
    const cleanArgs: Record<string, unknown> = {};
    for (const k of Object.keys(toolArgs)) if (allowedKeys.has(k)) cleanArgs[k] = toolArgs[k];
    // Record the specific canon entity this call consulted (even on a cache hit —
    // a deduped re-read is still a real dependency) for the consultation dep graph.
    const consulted = consultedRefFor(ctx, name, cleanArgs);
    if (consulted) recordShadowConsulted(chapterId, consulted);
    const cache = shadowToolCache.get(chapterId);
    const key = shadowCacheKey(name, cleanArgs);
    const cached = cache?.get(key);
    if (cached !== undefined) return { content: cached, status: 'ok' };
    // Let the UI paint before this tool's (possibly heavy) CPU burst — prose
    // hydration / full-project scan. Breaks the judge's tool-call burst-train.
    await yieldToMain();
    // Patches go through Shadow's effective-canon reader (timeline-filtered) so a
    // later-chapter evolution can't be used to excuse an earlier divergence.
    if (name === 'get_element_patches') {
      const outcome = await shadowEffectivePatchesText(ctx, chapterId, cleanArgs);
      cache?.set(key, outcome.content);
      return outcome;
    }
    const result = await runAgentTool(name, cleanArgs, ctx);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    cache?.set(key, text);
    return { content: text, status: 'ok' };
  };
}

// The chapter body as top-level blocks ({id, text}) from the live Yjs truth.
async function shadowChapterBlocks(
  chapterId: string,
): Promise<Array<{ id: string | null; text: string }>> {
  const content = await createBookContentRepository().findByNodeId(chapterId);
  const truthJson = await getChapterContentJson(chapterId, content?.contentJson ?? null);
  return docToBlocks(truthJson).map((b) => ({ id: b.blockId, text: b.text }));
}

async function shadowReadChapterSnapshot(ctx: AgentToolContext, args: Record<string, unknown>) {
  const chapterId = String(args.chapterId ?? '');
  throwIfShadowCancelled(chapterId);
  shadowToolCache.set(chapterId, new Map()); // fresh evidence cache for this review
  shadowConsultedByChapter.set(chapterId, new Map()); // fresh consultation edge set
  beginProseReadCache(); // hydrate each chapter's Y.Doc at most once for this review
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === chapterId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`shadow_read_chapter_snapshot: no chapter "${chapterId}"`);
  const blocks = await shadowChapterBlocks(chapterId);
  const refs = await listChapterReferences(s, chapterId);
  // rulesKv = whole-book ground truth: PROJECT facts only. The chapter's own
  // storyline facts/summary are fed separately (see buildWarmStart) so the judge
  // can tell book-wide canon from this arc's local canon — no longer merged here.
  const rulesKv: Record<string, string> = {};
  const project = useProjectStore.getState().currentProject;
  if (project) for (const kv of parseKv(project.kvJson)) rulesKv[kv.key] = kv.value;
  const appears = refs.map((r) => r.label);
  void traceShadow(chapterId, ctx.projectId, 'gather', '读取章节快照', {
    detail: `${blocks.length} 段${appears.length ? ` · 出场 ${appears.slice(0, 6).join('、')}` : ''}`,
  });
  return {
    projectId: ctx.projectId,
    chapterId,
    title: node.title,
    summary: node.summary ?? '',
    blocks,
    appears,
    rulesKv,
  };
}

async function shadowReadRules(ctx: AgentToolContext, args: Record<string, unknown>) {
  throwIfShadowCancelled(String(args.chapterId ?? ''));
  const rules = await createProjectRuleRepository().listByProject(ctx.projectId);
  const active = rules
    .filter((r) => r.enabled && r.checklist.length > 0)
    .map((r) => ({ id: r.id, checklist: r.checklist, kind: r.kind, judgingGuide: r.judgingGuide }));
  const chapterId = String(args.chapterId ?? '');
  if (chapterId) {
    const items = active.reduce((acc, r) => acc + r.checklist.length, 0);
    void traceShadow(chapterId, ctx.projectId, 'resolve', '加载规则', {
      detail: `${active.length} 条规则 · ${items} 项检查`,
    });
  }
  return active;
}

// Keep long evidence bodies from blowing the judge's context window.
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…（已截断）` : t;
}

// Build the on-demand evidence surface the agentic semantic judge pulls from:
// element profiles + evolution, free-floating drift nodes (settings/rules), and
// neighbouring chapters — all via this file's existing read helpers (the renderer
// owns the DB + Yjs). Progressive disclosure: the catalog hands the judge cheap
// summaries; full bodies are fetched only when it asks.
function buildShadowEvidenceProvider(ctx: AgentToolContext, chapterId: string): EvidenceProvider {
  const findElement = (name: string) => {
    const q = name.trim().toLowerCase();
    return useDataStore
      .getState()
      .bookElements.find(
        (e) =>
          e.projectId === ctx.projectId &&
          [e.name, ...e.aliases].some((n) => n.trim().toLowerCase() === q),
      );
  };
  const findNodeByTitle = (title: string, kind?: 'chapter' | 'drift') => {
    const q = title.trim().toLowerCase();
    return useDataStore
      .getState()
      .bookNodes.find(
        (n) =>
          n.projectId === ctx.projectId &&
          (!kind || n.kind === kind) &&
          n.title.trim().toLowerCase() === q,
      );
  };

  return {
    async catalog(): Promise<EvidenceCatalog> {
      const s = useDataStore.getState();
      const cur = s.bookNodes.find((n) => n.id === chapterId && n.projectId === ctx.projectId);
      const elementSummary = new Map(
        s.bookElements
          .filter((e) => e.projectId === ctx.projectId)
          .map((e) => [e.name, e.summary] as const),
      );
      const refs = await listChapterReferences(s, chapterId);
      const sceneEntities = refs
        .filter((r) => r.kind === 'element')
        .map((r) => ({ name: r.label, summary: elementSummary.get(r.label) || undefined }));
      const driftNodes = s.bookNodes
        .filter((n) => n.projectId === ctx.projectId && n.kind === 'drift')
        .slice(0, 40)
        .map((n) => ({ title: n.title, summary: n.summary || undefined }));
      // Prior chapter by narrative (story-time) order — the one most relevant to
      // continuity checks.
      let priorChapter: EvidenceCatalog['priorChapter'];
      if (cur && cur.narrativeOrder != null) {
        const curOrder = cur.narrativeOrder;
        const prev = s.bookNodes
          .filter(
            (n): n is typeof n & { narrativeOrder: number } =>
              n.projectId === ctx.projectId &&
              n.kind === 'chapter' &&
              n.narrativeOrder != null &&
              n.narrativeOrder < curOrder,
          )
          .sort((a, b) => b.narrativeOrder - a.narrativeOrder)[0];
        if (prev) priorChapter = { title: prev.title, summary: prev.summary || undefined };
      }
      return { sceneEntities, driftNodes, priorChapter };
    },

    async fetch(req: EvidenceRequest): Promise<string | null> {
      if (req.kind === 'element' || req.kind === 'element_evolution') {
        const el = findElement(req.name);
        if (!el) return null;
        if (req.kind === 'element') {
          const r = (await readElement(ctx, el.id)) as {
            summary?: string;
            aliases?: string[];
            facts?: { key: string; value: string }[];
            body?: string;
            patchCount?: number;
          };
          const lines: string[] = [];
          if (r.summary) lines.push(`简介：${r.summary}`);
          if (r.aliases?.length) lines.push(`别名：${r.aliases.join('、')}`);
          for (const f of r.facts ?? []) lines.push(`- ${f.key}：${f.value}`);
          if (r.body) lines.push(`正文：${truncate(r.body, 1500)}`);
          if (r.patchCount) lines.push(`（有 ${r.patchCount} 条状态演变，可用 element_evolution 索取）`);
          return lines.join('\n') || '（无内容）';
        }
        const r = (await getElementPatches(ctx, el.id)) as {
          patches: { title: string; sourceChapter?: string; body: string }[];
        };
        if (!r.patches.length) return '（无状态演变记录）';
        return r.patches
          .map(
            (p) =>
              `· ${p.title}${p.sourceChapter ? `（${p.sourceChapter}）` : ''}：${truncate(p.body, 400)}`,
          )
          .join('\n');
      }

      if (req.kind === 'drift' || req.kind === 'chapter') {
        const node = findNodeByTitle(req.name, req.kind === 'drift' ? 'drift' : 'chapter')
          ?? findNodeByTitle(req.name);
        if (!node) return null;
        const blocks = await shadowChapterBlocks(node.id);
        const text = blocks.map((b) => b.text).join('\n');
        const head = node.summary ? `梗概：${node.summary}\n---\n` : '';
        return `${head}${truncate(text, 4000)}`;
      }

      return null;
    },
  };
}

// Scene entities by SCANNING the prose for element names/aliases — NOT just the
// linked inline-mentions (those miss bare-name protagonists: 奥伦/凯尔 were absent
// while peripheral linked entities showed up). A warm-start hint, not ground truth;
// short names (<2 chars) are skipped so common characters don't false-match.
async function scanSceneEntities(
  projectId: string,
  blocks: Array<{ text: string }>,
): Promise<Array<{ name: string; summary?: string }>> {
  const text = blocks.map((b) => b.text).join('\n');
  const hits: Array<{ name: string; summary?: string }> = [];
  let scanned = 0;
  for (const e of useDataStore.getState().bookElements) {
    if (e.projectId !== projectId) continue;
    const names = [e.name, ...(e.aliases ?? [])]
      .map((n) => (n ?? '').trim())
      .filter((n) => n.length >= 2);
    if (names.some((n) => text.includes(n))) {
      hits.push({ name: e.name, summary: e.summary || undefined });
    }
    // E elements × includes() over the full prose is a synchronous burst — yield
    // periodically so a big cast / long chapter doesn't freeze the UI.
    if (++scanned % 24 === 0) await yieldToMain();
  }
  return hits.slice(0, 12);
}

// Warm-start context for the judge: chapter IDENTITY (so it can address its own
// node by name instead of guessing), prose-scanned scene entities, the prior
// chapter, and drift settings. Cheap summary-level hints; full bodies on demand.
async function buildWarmStart(
  ctx: AgentToolContext,
  node: { id: string; title: string; kind: string; narrativeOrder: number | null },
  blocks: Array<{ text: string }>,
): Promise<
  Pick<
    SemanticEvalContext,
    'identity' | 'sceneEntities' | 'priorChapter' | 'driftNodes' | 'storyline'
  >
> {
  const s = useDataStore.getState();
  const kind: 'chapter' | 'drift' = node.kind === 'drift' ? 'drift' : 'chapter';

  let position: string | undefined;
  let priorChapter: SemanticEvalContext['priorChapter'];
  if (kind === 'chapter' && node.narrativeOrder != null) {
    const order = node.narrativeOrder;
    const chapters = s.bookNodes
      .filter(
        (n): n is typeof n & { narrativeOrder: number } =>
          n.projectId === ctx.projectId && n.kind === 'chapter' && n.narrativeOrder != null,
      )
      .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
    // Total count only — telling the judge "第 N 章" nudged it to wander into
    // neighbouring chapters it didn't need.
    if (chapters.length > 0) position = `共 ${chapters.length} 章`;
    const prev = chapters.filter((n) => n.narrativeOrder < order).slice(-1)[0];
    if (prev) priorChapter = { title: prev.title, summary: prev.summary || undefined };
  }

  const driftNodes = s.bookNodes
    .filter((n) => n.projectId === ctx.projectId && n.kind === 'drift')
    .slice(0, 20)
    .map((n) => ({ title: n.title, summary: n.summary || undefined }));

  // The storyline this node primarily belongs to — its summary + own KV facts.
  // Fed alongside (not merged into) the whole-book facts so the judge grounds in
  // this arc's local canon. Drift nodes usually have no primary storyline → omit.
  let storyline: SemanticEvalContext['storyline'];
  const primaryStorylineId = s.primaryStorylineByNode[node.id];
  if (primaryStorylineId) {
    const sl = s.storylines.find((x) => x.id === primaryStorylineId);
    if (sl) {
      const facts: Record<string, string> = {};
      for (const kv of parseKv(sl.kvJson)) facts[kv.key] = kv.value;
      storyline = {
        name: sl.name,
        summary: sl.summary || undefined,
        facts: Object.keys(facts).length > 0 ? facts : undefined,
      };
    }
  }

  return {
    identity: { title: node.title, kind, position },
    sceneEntities: await scanSceneEntities(ctx.projectId, blocks),
    priorChapter,
    driftNodes,
    storyline,
  };
}

// Judge a RULE's semantic assertions together — one shared evidence loop per rule
// (not per item). The graph now batches a rule's checklist here so context (canon
// + reasoning) is gathered once across its related checks. Returns one
// SemanticViolation[] per input assertion, aligned by index.
async function shadowEvalSemanticBatch(ctx: AgentToolContext, args: Record<string, unknown>) {
  const chapterId = String(args.chapterId ?? '');
  throwIfShadowCancelled(chapterId);
  // Signal for the in-flight judge fetch — Stop aborts it so the LLM round-trip is
  // cancelled immediately (frees the main worker's serial queue), not at next entry.
  const abortSignal = registerShadowAborter(chapterId);
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === chapterId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`shadow_eval_semantic_batch: no chapter "${chapterId}"`);
  const assertions = Array.isArray(args.assertions)
    ? (args.assertions as unknown[]).map((a) => String(a ?? ''))
    : [];
  if (assertions.length === 0) return [] as SemanticViolation[][];

  await yieldToMain(); // paint before the chapter-prose hydration burst
  const blocks = await shadowChapterBlocks(chapterId);
  const facts =
    args.facts && typeof args.facts === 'object' ? (args.facts as Record<string, string>) : {};
  const summary = String(args.summary ?? '');
  // Dep-graph diff: what canon changed since this chapter's last review (old→new).
  // Empty on a first review / no prior snapshot → judge runs cold, as before.
  const changedDeps = computeChangedDeps(ctx.projectId, chapterId);
  // Per-rule judging template (LLM-authored, author-editable) + kind, threaded from the
  // rule through evaluateSemanticBatch → injected into the judge's prompt for this rule.
  const ruleKind = typeof args.ruleKind === 'string' ? args.ruleKind : undefined;
  const judgingGuide = typeof args.judgingGuide === 'string' ? args.judgingGuide : undefined;
  // Author overrides for the judge (the cross-agent share — see agent-memory):
  //  - exceptions: manual block notes the author marked kind='exception' on THIS
  //    chapter ("this flagged-looking passage is intentional"). Shadow's own
  //    comments are excluded (source!=='shadow').
  //  - memories: the project's ACTIVE agent memories (preferences/vetoes/directives).
  const exceptions = s.comments
    .filter(
      (c) =>
        c.projectId === ctx.projectId &&
        c.source !== 'shadow' &&
        c.kind === 'exception' &&
        c.targetKind === 'node' &&
        c.targetId === chapterId,
    )
    .map((c) => ({ blockId: c.targetBlockId, text: extractTextFromCommentBody(c.bodyJson) }))
    .filter((e) => e.text.trim());
  const memoryLabel = (k: string) => (k === 'veto' ? '否决' : k === 'directive' ? '指令' : '偏好');
  const memories = (await loadActiveMemories(ctx.projectId).catch(() => []))
    .map((m) => `[${memoryLabel(m.kind)}] ${m.body}`.trim())
    .filter(Boolean);
  const context: SemanticEvalContext = {
    facts,
    summary,
    ...(await buildWarmStart(ctx, node, blocks)),
    ...(changedDeps.length ? { changedDeps } : {}),
    ...(ruleKind ? { ruleKind } : {}),
    ...(judgingGuide?.trim() ? { judgingGuide } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    ...(memories.length ? { memories } : {}),
  };
  if (changedDeps.length) {
    void traceShadow(chapterId, ctx.projectId, 'gather', `依赖变更提示 ${changedDeps.length} 项`, {
      items: changedDeps.map((d) => (d.fact ? `${d.name}（${d.fact}）` : d.name)),
    });
  }

  const onTrace = (step: AgenticTraceStep) =>
    void traceShadow(chapterId, ctx.projectId, 'check', step.label, {
      detail: step.detail,
      items: step.items,
      calls: step.calls,
    });

  // Prefer a real function-calling loop when the substrate supports it (OpenAI-
  // compatible): the judge freely calls READ tools and rules on the whole rule's
  // checklist in ONE shared loop. Otherwise fall back to the Path-A menu loop,
  // judging each assertion in turn (no batched tool loop there).
  // Judge model follows the user's Shadow tier (设置 · Shadow). If the chosen tier
  // resolves to a model this transport can't reach (高/Sonnet on a local direct
  // build), degrade to the中档 DeepSeek model rather than failing every review —
  // and leave a trace so the downgrade is visible, not silent.
  let judgeModel = resolveShadowModel().model;
  try {
    ensureShadowModelRoutable(judgeModel);
  } catch {
    judgeModel = SHADOW_TIER_MODEL.standard;
    void traceShadow(chapterId, ctx.projectId, 'check', '高档 Sonnet 需托管，本次回退 DeepSeek-Pro');
  }

  const client = await buildShadowClient({ logTag: 'shadow:review' });
  if (client.supportsTools) {
    void traceShadow(chapterId, ctx.projectId, 'check', `检查 ${assertions.length} 项约束（${judgeModel}）`, {
      items: assertions,
    });
    return evaluateSemanticAssertionsFC(
      assertions,
      blocks,
      ctx.projectId,
      context,
      client,
      toAITools(AGENT_READ_TOOLS),
      makeShadowRunTool(ctx, chapterId),
      abortSignal,
      onTrace,
      // Record each judge round's token usage locally (Shadow runs direct-to-provider;
      // the server never sees it). No-ops when the proxy transport is on.
      (usage) => recordShadowUsage('shadow:review', judgeModel, usage),
      judgeModel,
    );
  }

  const provider = buildShadowEvidenceProvider(ctx, chapterId);
  const out: SemanticViolation[][] = [];
  for (const assertion of assertions) {
    throwIfShadowCancelled(chapterId);
    void traceShadow(chapterId, ctx.projectId, 'check', '检查约束', { detail: assertion });
    out.push(
      await evaluateSemanticAssertionAgentic(
        assertion,
        blocks,
        ctx.projectId,
        context,
        provider,
        abortSignal,
        onTrace,
      ),
    );
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// /goal 一键演化 — element-scoped evolve-critic substrate (shadow/GOAL-EVOLVE.md §4).
//
// Reuses the EXACT FC judge wiring (chapter blocks → shadow client → read tools →
// effective-canon-aware runTool → evaluateSemanticAssertionsFC) but the CRITERION
// is injected by the caller (lib/goal/evolve-critic) as a bespoke assertion +
// judgingGuide — NOT the project's review rules. "Shared substrate, forked
// criterion": coupling the loop to all rules would never converge (an unrelated
// pre-existing violation would keep a chapter red forever). No traceShadow / job
// state / changedDeps here — this runs OUTSIDE a shadow_job, driven by the renderer
// orchestrator. Returns one SemanticViolation[] per assertion, aligned by index.
// Build the pre-loaded canon block for a targeted critic: the element's FULL
// current content (name/aliases/summary/facts/body, from live Yjs) + its patches
// effective for THIS chapter (timeline-filtered). Injected so the evolve critic
// needn't spend a read_element + get_element_patches round per chapter.
async function buildPreloadedElementCanon(
  ctx: AgentToolContext,
  chapterId: string,
  elementId: string,
): Promise<string | undefined> {
  const el = useDataStore
    .getState()
    .bookElements.find((e) => e.id === elementId && e.projectId === ctx.projectId);
  if (!el) return undefined;
  const lines: string[] = [`设定《${el.name}》当前内容：`];
  if (el.aliases.length) lines.push(`别名：${el.aliases.join('、')}`);
  if (el.summary?.trim()) lines.push(`简介：${el.summary.trim()}`);
  const facts = parseKv(el.kvJson).filter((kv) => kv.key.trim() || kv.value.trim());
  if (facts.length) lines.push(`字段：\n${facts.map((kv) => `  - ${kv.key}：${kv.value}`).join('\n')}`);
  const body = docToPlainText(await getElementContentJson(elementId)).trim();
  if (body) lines.push(`正文设定：\n${body}`);
  // Timeline-filtered patches (later-chapter evolutions are withheld, same as the tool).
  const patches = await shadowEffectivePatchesText(ctx, chapterId, { element: elementId });
  lines.push(`对本章已生效的演化记录(patch)：\n${patches.content}`);
  return lines.join('\n');
}

export async function runEvolveCriticBatch(
  ctx: AgentToolContext,
  chapterId: string,
  assertions: string[],
  judgingGuide: string,
  // The element under evolution. When given, its full profile + this-chapter
  // effective patches are pre-loaded into context so the judge skips the lookups.
  preloadElementId?: string,
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<SemanticViolation[][]> {
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === chapterId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`runEvolveCriticBatch: no chapter "${chapterId}"`);
  if (assertions.length === 0) return [];
  const blocks = await shadowChapterBlocks(chapterId);
  if (blocks.length === 0) return assertions.map(() => []);

  // Same warm-start grounding as a review, but the policy is the evolve criterion
  // (judgingGuide) — no rules, no dep-hint/exceptions/memories. Plus the pre-loaded
  // element canon so the judge compares directly instead of fetching.
  const preloadedCanon = preloadElementId
    ? await buildPreloadedElementCanon(ctx, chapterId, preloadElementId)
    : undefined;
  const context: SemanticEvalContext = {
    summary: node.summary ?? '',
    ...(await buildWarmStart(ctx, node, blocks)),
    ...(preloadedCanon ? { preloadedCanon } : {}),
    judgingGuide,
  };

  let judgeModel = resolveShadowModel().model;
  try {
    ensureShadowModelRoutable(judgeModel);
  } catch {
    judgeModel = SHADOW_TIER_MODEL.standard;
  }

  const client = await buildShadowClient({ logTag: 'goal:evolve-critic' });
  if (client.supportsTools) {
    return evaluateSemanticAssertionsFC(
      assertions,
      blocks,
      ctx.projectId,
      context,
      client,
      toAITools(AGENT_READ_TOOLS),
      makeShadowRunTool(ctx, chapterId),
      signal,
      onTrace,
      (usage) => recordShadowUsage('goal:evolve-critic', judgeModel, usage),
      judgeModel,
    );
  }
  // No tool loop on this transport → the menu-driven agentic judge (still effective-
  // canon aware via element_evolution), one assertion at a time.
  const provider = buildShadowEvidenceProvider(ctx, chapterId);
  const out: SemanticViolation[][] = [];
  for (const assertion of assertions) {
    out.push(
      await evaluateSemanticAssertionAgentic(assertion, blocks, ctx.projectId, context, provider, signal, onTrace),
    );
  }
  return out;
}

// ── /goal evolve · self-built FC editor (Shadow provider) ────────────────────
// Write-tools the editor loop may call. Kept TINY (only block edits + finish) so a
// shadow-provider model can't reach create/delete tools — the loop edits one fixed
// chapter, the chapter ref is injected by the executor (model only gives block+text).
const EVOLVE_EDIT_BLOCK_TOOL: AITool = {
  name: 'edit_block',
  description: '替换某一段的文本（按段编号，1 起）。只对与设定改动直接冲突处做最小改动。',
  parametersSchema: {
    type: 'object',
    properties: {
      block: { type: 'number', description: '段编号(1 起，对应上文「正文」的编号)' },
      text: { type: 'string', description: '该段改写后的完整文本' },
    },
    required: ['block', 'text'],
  },
};
const EVOLVE_EDIT_BLOCKS_TOOL: AITool = {
  name: 'edit_blocks',
  description: '一次替换多段文本（按段编号）。',
  parametersSchema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { block: { type: 'number' }, text: { type: 'string' } },
          required: ['block', 'text'],
        },
      },
    },
    required: ['edits'],
  },
};
const EVOLVE_FINISH_TOOL: AITool = {
  name: 'finish_edits',
  description: '所有需要的最小改动已完成（或本章无需改动）。',
  parametersSchema: { type: 'object', properties: {} },
};

// Runs on the SHADOW provider (no Anthropic dependency). Mirrors runEvolveCriticBatch's
// loop, but the tools WRITE: the model calls edit_block/edit_blocks (dispatched through
// runAgentTool → live Yjs + soft-approval, recorded with shadowEditMode via the override)
// and finish_edits to stop. Returns the block ids it changed.
export async function runShadowEditBatch(
  ctx: AgentToolContext,
  chapterId: string,
  instruction: string,
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<{ ok: boolean; editedBlockIds: string[]; error?: string }> {
  const node = useDataStore.getState().bookNodes.find((n) => n.id === chapterId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`runShadowEditBatch: no chapter "${chapterId}"`);
  const blocks = await shadowChapterBlocks(chapterId);
  if (blocks.length === 0) return { ok: true, editedBlockIds: [] };
  const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');

  let model = resolveShadowModel().model;
  try {
    ensureShadowModelRoutable(model);
  } catch {
    model = SHADOW_TIER_MODEL.standard;
  }
  const client = await buildShadowClient({ logTag: 'goal:evolve-edit' });
  if (!client.supportsTools) {
    return {
      ok: false,
      editedBlockIds: [],
      error: 'Shadow provider 不支持工具调用，无法用自建 FC editor（改用 Agent SDK 引擎）',
    };
  }

  const tools = [EVOLVE_EDIT_BLOCK_TOOL, EVOLVE_EDIT_BLOCKS_TOOL, EVOLVE_FINISH_TOOL];
  const system = [
    '你是小说写作的定向改稿器。给你一章正文(按段编号)和一项设定改动 + 需修正的冲突点。',
    '只对与该设定改动【直接冲突】的段落做【最小】改动，使其符合新设定；不要改无关内容、不要新增设定外的事实、不要整段重写语气。',
    '用 edit_block / edit_blocks 按段编号替换文本；全部改完（或本章无需改动）就调用 finish_edits。',
    `用 ${resolveWritingLanguage(ctx.projectId)} 写。`,
  ].join('\n');
  const messages: AIMessage[] = [
    { role: 'user', content: `${instruction}\n\n正文（按段编号）：\n${numbered}` },
  ];

  const editedBlockIds: string[] = [];
  const maxRounds = 8;
  const maxToolCalls = 16;
  let toolCalls = 0;
  for (let round = 0; round < maxRounds; round++) {
    const resp = await client.complete({
      model,
      system,
      messages,
      tools,
      toolChoice: 'auto',
      thinking: false,
      signal,
      metadata: { feature: 'goal-evolve-edit' },
    });
    if (resp.usage) recordShadowUsage('goal:evolve-edit', model, resp.usage);
    const calls: AIToolCall[] = resp.toolCalls ?? (resp.toolCall ? [resp.toolCall] : []);
    if (calls.length === 0) {
      // Model answered in prose without editing → stop.
      if (resp.text?.trim()) onTrace?.({ label: '改稿器以文字收尾（未再调工具）', detail: resp.text.trim().slice(0, 200) });
      break;
    }
    messages.push({ role: 'model', content: resp.text ?? '', toolCalls: calls });

    let finished = false;
    const traceCalls: ShadowToolCall[] = [];
    for (const call of calls) {
      if (call.name === 'finish_edits') {
        finished = true;
        messages.push({ role: 'tool', toolCallId: call.id, content: 'ok' });
        traceCalls.push({ tool: 'finish_edits', status: 'ok' });
        continue;
      }
      toolCalls += 1;
      const args =
        call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {};
      // Trace summary: which blocks, and a peek at the replacement text.
      const argsLabel =
        call.name === 'edit_block'
          ? `段${String(args.block)}：${String(args.text ?? '').slice(0, 80)}`
          : call.name === 'edit_blocks' && Array.isArray(args.edits)
            ? `段${(args.edits as { block?: unknown }[]).map((e) => String(e?.block)).join('、')}`
            : undefined;
      try {
        let res: unknown;
        if (call.name === 'edit_block') {
          res = await runAgentTool('edit_block', { node: chapterId, block: args.block, text: args.text }, ctx);
        } else if (call.name === 'edit_blocks') {
          res = await runAgentTool('edit_blocks', { node: chapterId, edits: args.edits }, ctx);
        } else {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `没有名为「${call.name}」的工具，只能用 edit_block / edit_blocks / finish_edits`,
          });
          traceCalls.push({ tool: call.name, status: 'denied', note: '未知工具' });
          continue;
        }
        const ids = (res as { blockIds?: string[] }).blockIds;
        if (ids) editedBlockIds.push(...ids);
        messages.push({ role: 'tool', toolCallId: call.id, content: '已应用' });
        traceCalls.push({ tool: call.name, args: argsLabel, status: 'ok', result: '已应用' });
      } catch (e) {
        if (e instanceof Error && e.name === 'ShadowCancelledError') throw e;
        const msg = e instanceof Error ? e.message : String(e);
        messages.push({ role: 'tool', toolCallId: call.id, content: `（改动失败：${msg}）` });
        traceCalls.push({ tool: call.name, args: argsLabel, status: 'error', note: msg });
      }
    }
    if (traceCalls.length) {
      const bad = traceCalls.filter((c) => c.status !== 'ok').length;
      onTrace?.({ label: bad ? `改稿 · 第 ${round + 1} 轮（${bad} 失败）` : `改稿 · 第 ${round + 1} 轮`, calls: traceCalls });
    }
    if (finished || toolCalls >= maxToolCalls) break;
    await yieldToMain();
  }
  return { ok: true, editedBlockIds: [...new Set(editedBlockIds)] };
}

async function shadowClearComments(ctx: AgentToolContext, args: Record<string, unknown>) {
  const chapterId = String(args.chapterId ?? '');
  const stale = useDataStore
    .getState()
    .comments.filter(
      (c) =>
        c.projectId === ctx.projectId &&
        c.source === 'shadow' &&
        c.targetKind === 'node' &&
        c.targetId === chapterId,
    );
  for (const c of stale) await ctx.write.deleteComment(c.id);
  return { ok: true, cleared: stale.length };
}

async function shadowWriteComment(ctx: AgentToolContext, args: Record<string, unknown>) {
  const chapterId = String(args.chapterId ?? '');
  const finding = (args.finding ?? {}) as {
    message?: string;
    reason?: string;
    blockId?: string | null;
    blockIds?: string[];
    ruleId?: string;
    itemId?: string;
  };
  const message = String(finding.message ?? '').trim();
  if (!chapterId || !message) return { ok: false };
  throwIfShadowCancelled(chapterId);
  const reason = String(finding.reason ?? '').trim();
  const body = reason ? `${message}\n${reason}` : message;
  // The full consecutive block range goes in metadataJson.blockIds; targetBlockId
  // stays the first block (card position). CommentRail reads blockIds for the
  // anchor-mark + hover highlight, so one comment spans the whole range.
  const blockIds = Array.isArray(finding.blockIds)
    ? finding.blockIds.filter((b): b is string => typeof b === 'string' && b.length > 0)
    : [];
  // Snapshot the violating blocks' live text so the shadow comment, like manual
  // ones, can show "原文" on demand and detect when the prose later diverges.
  // Shadow findings are block-level, so no precise textAnchor — whole blocks.
  const snapBlockIds = blockIds.length
    ? blockIds
    : typeof finding.blockId === 'string' && finding.blockId
      ? [finding.blockId]
      : [];
  const chapterBlocks = await shadowChapterBlocks(chapterId);
  const textById = new Map(
    chapterBlocks.filter((b) => b.id).map((b) => [b.id as string, b.text]),
  );
  const blockSnapshots = snapBlockIds.map((id) => ({
    blockId: id,
    blockText: textById.get(id) ?? '',
  }));
  const input: CreateCommentInput = {
    kind: 'note',
    bodyJson: createPlainCommentDoc(body),
    targetKind: 'node',
    targetId: chapterId,
    targetBlockIds: blockIds,
    anchorJson: JSON.stringify({ createdAt: new Date().toISOString(), blockSnapshots }),
    authorKind: 'ai',
    authorName: 'Shadow',
    source: 'shadow',
    metadataJson: JSON.stringify({ ruleId: finding.ruleId ?? '', itemId: finding.itemId ?? '' }),
  };
  if (typeof finding.blockId === 'string' && finding.blockId) {
    input.targetBlockId = finding.blockId;
  }
  const created = await ctx.write.createComment(input);
  void traceShadow(chapterId, ctx.projectId, 'emit', '写入批注', {
    detail: message,
    items: reason ? [reason] : undefined,
  });
  return { ok: true, commentId: (created as { id?: string })?.id };
}

async function shadowSetStatus(ctx: AgentToolContext, args: Record<string, unknown>) {
  const chapterId = String(args.chapterId ?? '');
  const status =
    args.status === 'finished' ? 'finished' : args.status === 'draft' ? 'draft' : null;
  if (!chapterId || !status) throw new Error('shadow_set_status: requires chapterId + finished|draft');
  void traceShadow(chapterId, ctx.projectId, 'decide', status === 'finished' ? '结论：已完成' : '结论：退回草稿');
  await ctx.write.updateNode(chapterId, { writingStatus: status });
  // Persist the entities this review consulted (precise dep edges) AND a value snapshot
  // of them — the baseline a later re-review diffs current canon against to build the
  // changed-dep hint. Done before freeing the per-review caches.
  const consulted = takeShadowConsulted(chapterId);
  void setShadowConsulted(chapterId, ctx.projectId, consulted, snapshotConsulted(consulted));
  shadowToolCache.delete(chapterId); // review done — free its evidence cache
  endProseReadCache(); // free the per-review prose-hydration cache
  return { ok: true, chapterId, status };
}

/** Dispatch a tool call to its handler. Throws on unknown/missing. */
export async function runAgentTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<unknown> {
  // Accept entity NAMES (project-unique) anywhere an id arg is expected.
  const args = resolveArgsRefs(ctx, rawArgs);
  switch (name) {
    // reads
    case 'list_nodes':
      return listChapters(ctx);
    case 'list_elements':
      return listElements(ctx);
    case 'read_node':
      return readEntityBlocks(ctx, args);
    case 'read_element':
      return readElement(ctx, String(args.elementId ?? ''));
    case 'search_project':
      return searchProject(ctx, String(args.query ?? ''));
    // relational / context reads (point → surface)
    case 'get_overview':
      return getOverview(ctx);
    case 'get_project_brief':
      return getProjectBrief(ctx);
    case 'where_does_entity_appear':
      return whereDoesEntityAppear(ctx, args);
    case 'get_entity_relations':
      return getEntityRelations(ctx, args);
    case 'get_storyline':
      return getStoryline(ctx, String(args.storylineId ?? ''));
    case 'search_prose':
      return searchProse(ctx, args);
    case 'get_element_patches':
      return getElementPatches(ctx, String(args.elementId ?? ''));
    case 'list_comments':
      return listComments(ctx, args);
    // writes
    case 'update_element':
      return updateElement(ctx, args);
    case 'set_entity_body':
      return setEntityBody(ctx, args);
    case 'set_element_body': // deprecated alias — element-only
      return setEntityBody(ctx, { ...args, kind: 'element' });
    case 'create_element':
      return createElement(ctx, args);
    case 'rename_node':
      return renameChapter(ctx, args);
    case 'set_node_summary':
      return setNodeSummary(ctx, args);
    case 'edit_block':
      return editBlock(ctx, args);
    case 'edit_blocks':
      return editBlocks(ctx, args);
    case 'append_paragraph':
      return appendParagraphTool(ctx, args);
    case 'read_block':
      return readBlock(ctx, args);
    case 'lookup_block':
      return lookupBlock(ctx, args);
    case 'remove_blocks':
      return removeBlocksTool(ctx, args);
    case 'replace_block_range':
      return replaceBlockRangeTool(ctx, args);
    case 'insert_blocks':
      return insertBlocksTool(ctx, args);
    // relationships
    case 'link_chapter_to_storyline':
      return linkChapterToStoryline(ctx, args);
    case 'unlink_chapter_from_storyline':
      return unlinkChapterFromStoryline(ctx, args);
    case 'set_primary_storyline':
      return setPrimaryStoryline(ctx, args);
    case 'add_relation':
      return addRelation(ctx, args);
    case 'remove_relation':
      return removeRelation(ctx, args);
    case 'update_relation_kind':
      return updateRelationKind(ctx, args);
    // entity creation (containers to relate into)
    case 'create_storyline':
      return createStorylineTool(ctx, args);
    case 'update_storyline':
      return updateStorylineTool(ctx, args);
    case 'create_category':
      return createCategoryTool(ctx, args);
    case 'update_category':
      return updateCategoryTemplate(ctx, args);
    case 'update_project_facts':
      return updateProjectFacts(ctx, args);
    // agent memory (author-level standing guidance)
    case 'remember':
      return rememberTool(ctx, args);
    case 'list_memory':
      return listMemoryTool(ctx, args);
    case 'forget':
      return forgetTool(ctx, args);
    case 'create_node':
      return createNodeTool(ctx, args);
    // summary (reverse-generate)
    case 'set_summary':
      return setSummary(ctx, args);
    // element patches
    case 'create_element_patch':
      return createElementPatch(ctx, args);
    case 'update_element_patch':
      return updateElementPatch(ctx, args);
    case 'delete_element_patch':
      return deleteElementPatch(ctx, args);
    // comments / todos
    case 'create_comment':
      return createComment(ctx, args);
    case 'delete_comment':
      return deleteCommentTool(ctx, args);
    case 'set_comment_status':
      return setCommentStatus(ctx, args);
    case 'set_comment_kind':
      return setCommentKind(ctx, args);
    // destructive
    case 'delete_element':
      return deleteElement(ctx, args);
    // shadow review (main-process LangGraph engine ↔ bridge)
    case 'shadow_read_chapter_snapshot':
      return shadowReadChapterSnapshot(ctx, args);
    case 'shadow_read_rules':
      return shadowReadRules(ctx, args);
    case 'shadow_eval_semantic_batch':
      return shadowEvalSemanticBatch(ctx, args);
    case 'shadow_clear_comments':
      return shadowClearComments(ctx, args);
    case 'shadow_write_comment':
      return shadowWriteComment(ctx, args);
    case 'shadow_set_status':
      return shadowSetStatus(ctx, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
