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
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import {
  createElementPatchRepository,
  type CreatePatchInput,
  type UpdatePatchInput,
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
  getBlockSnapshotFromAnchor,
  getSelectedTextFromAnchor,
} from '../../domain/comment';
import type { CreateCommentInput } from '../../usecase/useComment';
import type { NodeContent } from '../../domain/node-content';
import {
  isEntityKind,
  isStructuralEntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
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
} from './chapter-prose';
import { proseDocId, type ProseEntityType } from '../yjs-doc-id';
import { getLiveYDoc } from '../yjs-doc-registry';
import { eventBus } from '../events';
import { requestAgentConfirm } from '../../store/agent-confirm-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useSettingsStore } from '../../store/settings-store';
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
    .record(entityType, id, changes, useSettingsStore.getState().agentEditMode);
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
}

export interface AgentToolContext {
  projectId: string;
  write: AgentWriteApi;
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
 * projection. Shared by read_node and get_node_context.
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

async function readChapter(ctx: AgentToolContext, nodeId: string) {
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === nodeId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`No chapter/node found with id "${nodeId}"`);
  const content = await createBookContentRepository().findByNodeId(nodeId);
  // Read the live Yjs truth (what the editor shows), not just the contentJson
  // cache, so the numbering the agent edits against matches the open editor.
  const truthJson = await getChapterContentJson(nodeId, content?.contentJson ?? null);
  const blocks = docToBlocks(truthJson);
  // Compact numbered rendering — the leading number is the handle for edit_block.
  const header = `${node.kind} "${node.title}" · ${node.writingStatus} · ${node.wordCount}字`;
  const summaryLine = `summary: ${node.summary || '(none)'}`;
  // Which elements/entities appear in this chapter (recorded inline mentions),
  // so the agent has context without a separate get_node_context call.
  const refs = await listChapterReferences(s, nodeId);
  // Names are project-unique, so list appearances by name+kind (no long ids).
  const appearsLine = refs.length
    ? `appears: ${refs.map((r) => `${r.label} (${r.kind})`).join(', ')}`
    : 'appears: (none recorded)';
  const body = blocks.length ? blocksToCompactText(blocks) : '(empty)';
  return `${header}\n${summaryLine}\n${appearsLine}\n\n${body}`;
}

/**
 * read_node, generalized over prose entities. A chapter/drift node keeps the
 * rich numbered view (header · summary · appears); element / storyline /
 * category get a body-only numbered view — they have no writingStatus / word
 * count / inline-mention projection, so emitting those lines would be misleading.
 */
async function readEntityBlocks(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  if (entityType === 'node') return readChapter(ctx, id);
  const truthJson = await getEntityContentJson(entityType, id);
  const blocks = docToBlocks(truthJson);
  const label = entityLabel(useDataStore.getState(), entityType, id);
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
  // Excludes soft-deleted ones so it matches what get_element_patches returns.
  const del = pendingDeletedPatchIds(elementId);
  const patchCount = (await createElementPatchRepository().listByElement(elementId)).filter(
    (p) => !del.has(p.id),
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

/**
 * Resolve an entity NAME to its id (exact, case-insensitive) so the agent can
 * address entities by name instead of long uuids. Names are kept project-unique
 * per kind (#11), so this normally returns one id; if a name still collides
 * (e.g. legacy duplicates) it returns `ambiguous` rather than guessing.
 */
function resolveEntity(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim().toLowerCase();
  if (!name) throw new Error('resolve_entity requires a name');
  const s = useDataStore.getState();
  const matches: Array<{ kind: string; id: string; label: string }> = [];
  const wantNode = !kind || kind === 'node' || kind === 'chapter' || kind === 'drift';

  if (!kind || kind === 'element') {
    for (const e of s.bookElements) {
      if (e.projectId !== ctx.projectId) continue;
      if ([e.name, ...e.aliases].some((n) => n.trim().toLowerCase() === name)) {
        matches.push({ kind: 'element', id: e.id, label: e.name });
      }
    }
  }
  if (wantNode) {
    for (const n of s.bookNodes) {
      if (n.projectId !== ctx.projectId) continue;
      if (n.title.trim().toLowerCase() === name) matches.push({ kind: n.kind, id: n.id, label: n.title });
    }
  }
  if (!kind || kind === 'storyline') {
    for (const sl of s.storylines) {
      if (sl.projectId !== ctx.projectId) continue;
      if (sl.name.trim().toLowerCase() === name) matches.push({ kind: 'storyline', id: sl.id, label: sl.name });
    }
  }
  if (!kind || kind === 'category') {
    for (const c of s.bookElementCategories) {
      if (c.projectId !== ctx.projectId) continue;
      if (c.name.trim().toLowerCase() === name) matches.push({ kind: 'category', id: c.id, label: c.name });
    }
  }

  if (matches.length === 0) return { found: false, matches: [] };
  if (matches.length === 1) {
    return { found: true, id: matches[0].id, kind: matches[0].kind, label: matches[0].label };
  }
  return { found: true, ambiguous: matches };
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

/** Where a structural entity is mentioned in prose (its appearances/backlinks). */
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
  // Sources are surfaced by name (`from`), not id.
  const bySource = new Map<string, { fromKind: string; from: string; blockIds: string[] }>();
  for (const b of backlinks) {
    const key = `${b.fromKind}:${b.fromId}`;
    const cur = bySource.get(key) ?? { fromKind: b.fromKind, from: b.fromTitle, blockIds: [] };
    cur.blockIds.push(b.fromBlockId);
    bySource.set(key, cur);
  }
  const appearances = [...bySource.values()].map((a) => ({ ...a, mentionCount: a.blockIds.length }));
  return { target: { kind, name: entityLabel(s, kind, id) }, appearances };
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

/**
 * Cheap "what is this chapter about + what it connects to" — summary, rolling
 * block-section summaries, referenced elements, storylines and relations —
 * WITHOUT pulling the full prose. Call this before read_node.
 */
async function getChapterContext(ctx: AgentToolContext, nodeId: string) {
  if (!nodeId) throw new Error('get_node_context requires node');
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === nodeId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`No chapter/node found with id "${nodeId}"`);

  const storylineIds = s.nodeStorylineMapping[nodeId] ?? [];
  const storylines = storylineIds.map((id) => ({
    name: entityLabel(s, 'storyline', id),
    primary: s.primaryStorylineByNode[nodeId] === id,
  }));
  const rollingSummaries = s.blockSections
    .filter((b) => b.chapterId === nodeId)
    .map((b) => b.summary)
    .filter(Boolean);

  // Elements (and other structural entities) this node references in prose, by name.
  const references = (await listChapterReferences(s, nodeId)).map((r) => ({
    kind: r.kind,
    name: r.label,
  }));

  const rels = s.entityRelations.filter((r) => r.projectId === ctx.projectId);
  const relations = [
    ...rels
      .filter((r) => r.fromKind === 'node' && r.fromId === nodeId)
      .map((r) => ({ dir: 'out' as const, relation: r.kind, kind: r.toKind, name: entityLabel(s, r.toKind, r.toId) })),
    ...rels
      .filter((r) => r.toKind === 'node' && r.toId === nodeId)
      .map((r) => ({ dir: 'in' as const, relation: r.kind, kind: r.fromKind, name: entityLabel(s, r.fromKind, r.fromId) })),
  ];

  return {
    title: node.title,
    kind: node.kind,
    summary: node.summary,
    wordCount: node.wordCount,
    writingStatus: node.writingStatus,
    bookOrder: node.bookOrder,
    narrativeOrder: node.narrativeOrder,
    storylines,
    rollingSummaries,
    references,
    relations,
  };
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
  // the agent's view matches its belief that it deleted them.
  const del = pendingDeletedPatchIds(elementId);
  const patches = (await createElementPatchRepository().listByElement(elementId)).filter(
    (p) => !del.has(p.id),
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

async function removeBlocksTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { entityType, id } = resolveProseTarget(ctx, args);
  const blockIds = Array.isArray(args.blockIds) ? args.blockIds.map((b) => String(b)) : [];
  if (blockIds.length === 0) throw new Error('remove_blocks requires a non-empty blockIds array');
  return withProseLock(proseDocId(entityType, id), async () => {
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
  const fromBlockId = String(args.fromBlockId ?? '');
  const toBlockId = String(args.toBlockId ?? '');
  if (!fromBlockId || !toBlockId) {
    throw new Error('replace_block_range requires fromBlockId and toBlockId');
  }
  const { entityType, id } = resolveProseTarget(ctx, args);
  const texts = Array.isArray(args.blocks) ? args.blocks.map((b) => String(b)) : [];
  return withProseLock(proseDocId(entityType, id), async () => {
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
  const afterBlockId =
    args.afterBlockId === undefined || args.afterBlockId === null || args.afterBlockId === ''
      ? null
      : String(args.afterBlockId);
  const texts = Array.isArray(args.blocks) ? args.blocks.map((b) => String(b)) : [];
  if (texts.length === 0) throw new Error('insert_blocks requires a non-empty blocks array');
  const { entityType, id } = resolveProseTarget(ctx, args);
  return withProseLock(proseDocId(entityType, id), async () => {
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
    kind: args.kind === 'todo' ? 'todo' : 'note',
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
  else throw new Error(`kind must be 'todo' or 'note', got "${kind}"`);
  return { ok: true, commentId: id, kind };
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
    case 'resolve_entity':
      return resolveEntity(ctx, args);
    // relational / context reads (point → surface)
    case 'get_project_brief':
      return getProjectBrief(ctx);
    case 'where_does_entity_appear':
      return whereDoesEntityAppear(ctx, args);
    case 'get_entity_relations':
      return getEntityRelations(ctx, args);
    case 'get_storyline':
      return getStoryline(ctx, String(args.storylineId ?? ''));
    case 'get_node_context':
      return getChapterContext(ctx, String(args.nodeId ?? ''));
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
