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
import { createElementPatchRepository } from '../../sqlite-repo/element-patch-repo';
import { isChapter, type BookNode } from '../../domain/book-node';
import { parseKv } from '../../domain/kv';
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
import { docToBlocks, docToPlainText, replaceBlockText, appendParagraph } from './serialize';

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
  removeElement: (id: string) => Promise<unknown>;
}

export interface AgentToolContext {
  projectId: string;
  write: AgentWriteApi;
}

function listProjectStructure(ctx: AgentToolContext) {
  const s = useDataStore.getState();
  const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
  return {
    chapters: nodes
      .filter(isChapter)
      .map((n) => ({ id: n.id, title: n.title, status: n.writingStatus, wordCount: n.wordCount })),
    drifts: nodes
      .filter((n) => n.kind === 'drift')
      .map((n) => ({ id: n.id, title: n.title })),
    storylines: s.storylines
      .filter((sl) => sl.projectId === ctx.projectId)
      .map((sl) => ({ id: sl.id, name: sl.name })),
    elementCategories: s.bookElementCategories
      .filter((c) => c.projectId === ctx.projectId)
      .map((c) => ({ id: c.id, name: c.name })),
    elements: s.bookElements
      .filter((e) => e.projectId === ctx.projectId)
      .map((e) => ({ id: e.id, name: e.name, categoryId: e.categoryId, summary: e.summary })),
  };
}

async function readChapter(ctx: AgentToolContext, nodeId: string) {
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === nodeId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`No chapter/node found with id "${nodeId}"`);
  const content = await createBookContentRepository().findByNodeId(nodeId);
  const blocks = content ? docToBlocks(content.contentJson) : [];
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    summary: node.summary,
    blocks: blocks.map((b) => ({ blockId: b.blockId, type: b.type, text: b.text })),
  };
}

function readElement(ctx: AgentToolContext, elementId: string) {
  const s = useDataStore.getState();
  const el = s.bookElements.find((e) => e.id === elementId && e.projectId === ctx.projectId);
  if (!el) throw new Error(`No element found with id "${elementId}"`);
  return {
    id: el.id,
    name: el.name,
    summary: el.summary,
    aliases: el.aliases,
    groupName: el.groupName,
    categoryId: el.categoryId,
    facts: parseKv(el.kvJson),
    body: docToPlainText(el.contentJson),
  };
}

function searchProject(ctx: AgentToolContext, query: string) {
  const q = query.trim().toLowerCase();
  const matches: Array<{ kind: string; id: string; label: string }> = [];
  if (!q) return { matches };

  const s = useDataStore.getState();
  for (const n of s.bookNodes) {
    if (n.projectId !== ctx.projectId) continue;
    if (n.title.toLowerCase().includes(q)) matches.push({ kind: n.kind, id: n.id, label: n.title });
  }
  for (const e of s.bookElements) {
    if (e.projectId !== ctx.projectId) continue;
    const hay = [e.name, e.summary, ...e.aliases].join(' ').toLowerCase();
    if (hay.includes(q)) matches.push({ kind: 'element', id: e.id, label: e.name });
  }
  for (const sl of s.storylines) {
    if (sl.projectId !== ctx.projectId) continue;
    if (sl.name.toLowerCase().includes(q)) matches.push({ kind: 'storyline', id: sl.id, label: sl.name });
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
    description: project ? docToPlainText(project.descriptionJson) : '',
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
async function whereDoesEntityAppear(_ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '');
  const id = String(args.id ?? '');
  if (!isStructuralEntityKind(kind)) {
    throw new Error(`kind must be structural (node/element/storyline/category/patch), got "${kind}"`);
  }
  if (!id) throw new Error('where_does_entity_appear requires id');
  const s = useDataStore.getState();
  const backlinks = await createInlineMentionRepository().listBacklinksToTarget(kind, id);
  // Group by source entity (one source can mention the target in many blocks).
  const bySource = new Map<
    string,
    { fromKind: string; fromId: string; fromTitle: string; blockIds: string[] }
  >();
  for (const b of backlinks) {
    const key = `${b.fromKind}:${b.fromId}`;
    const cur =
      bySource.get(key) ??
      { fromKind: b.fromKind, fromId: b.fromId, fromTitle: b.fromTitle, blockIds: [] };
    cur.blockIds.push(b.fromBlockId);
    bySource.set(key, cur);
  }
  const appearances = [...bySource.values()].map((a) => ({ ...a, mentionCount: a.blockIds.length }));
  return { target: { kind, id, label: entityLabel(s, kind, id) }, appearances };
}

/** The curated cross-entity relation edges touching an entity, both directions. */
function getEntityRelations(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '');
  const id = String(args.id ?? '');
  if (!kind || !id) throw new Error('get_entity_relations requires kind and id');
  const s = useDataStore.getState();
  const rels = s.entityRelations.filter((r) => r.projectId === ctx.projectId);
  const outgoing = rels
    .filter((r) => r.fromKind === kind && r.fromId === id)
    .map((r) => ({ relation: r.kind, toKind: r.toKind, toId: r.toId, toLabel: entityLabel(s, r.toKind, r.toId) }));
  const incoming = rels
    .filter((r) => r.toKind === kind && r.toId === id)
    .map((r) => ({ relation: r.kind, fromKind: r.fromKind, fromId: r.fromId, fromLabel: entityLabel(s, r.fromKind, r.fromId) }));
  return { entity: { kind, id, label: entityLabel(s, kind, id) }, outgoing, incoming };
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
        id: n.id,
        title: n.title,
        bookOrder: n.bookOrder,
        isPrimary: s.primaryStorylineByNode[nid] === storylineId,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.bookOrder ?? 0) - (b.bookOrder ?? 0));
  return { id: sl.id, name: sl.name, summary: sl.summary, facts: parseKv(sl.kvJson), chapters };
}

/**
 * Cheap "what is this chapter about + what it connects to" — summary, rolling
 * block-section summaries, referenced elements, storylines and relations —
 * WITHOUT pulling the full prose. Call this before read_chapter.
 */
async function getChapterContext(ctx: AgentToolContext, nodeId: string) {
  if (!nodeId) throw new Error('get_chapter_context requires nodeId');
  const s = useDataStore.getState();
  const node = s.bookNodes.find((n) => n.id === nodeId && n.projectId === ctx.projectId);
  if (!node) throw new Error(`No chapter/node found with id "${nodeId}"`);

  const storylineIds = s.nodeStorylineMapping[nodeId] ?? [];
  const storylines = storylineIds.map((id) => ({
    id,
    name: entityLabel(s, 'storyline', id),
    primary: s.primaryStorylineByNode[nodeId] === id,
  }));
  const rollingSummaries = s.blockSections
    .filter((b) => b.chapterId === nodeId)
    .map((b) => b.summary)
    .filter(Boolean);

  // Elements (and other structural entities) this chapter references in prose.
  const mentions = await createInlineMentionRepository().listMentionsFromSource('node', nodeId);
  const seen = new Set<string>();
  const references: Array<{ kind: string; id: string; label: string }> = [];
  for (const m of mentions) {
    const key = `${m.toKind}:${m.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ kind: m.toKind, id: m.toId, label: entityLabel(s, m.toKind, m.toId) });
  }

  const rels = s.entityRelations.filter((r) => r.projectId === ctx.projectId);
  const relations = [
    ...rels
      .filter((r) => r.fromKind === 'node' && r.fromId === nodeId)
      .map((r) => ({ dir: 'out' as const, relation: r.kind, kind: r.toKind, id: r.toId, label: entityLabel(s, r.toKind, r.toId) })),
    ...rels
      .filter((r) => r.toKind === 'node' && r.toId === nodeId)
      .map((r) => ({ dir: 'in' as const, relation: r.kind, kind: r.fromKind, id: r.fromId, label: entityLabel(s, r.fromKind, r.fromId) })),
  ];

  return {
    id: node.id,
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
async function searchProse(ctx: AgentToolContext, args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  const matches: Array<{ kind: string; id: string; title: string; blockId?: string; snippet: string }> = [];
  if (!q) return { matches };

  const s = useDataStore.getState();

  // Element bodies are in memory — cheap.
  for (const e of s.bookElements) {
    if (e.projectId !== ctx.projectId) continue;
    const text = docToPlainText(e.contentJson);
    const idx = text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      matches.push({ kind: 'element', id: e.id, title: e.name, snippet: snippetAround(text, idx, q.length) });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }

  // Chapter / drift prose — load per node (no FTS index exists).
  const contentRepo = createBookContentRepository();
  const nodes = s.bookNodes.filter((n) => n.projectId === ctx.projectId);
  for (const n of nodes) {
    const content = await contentRepo.findByNodeId(n.id);
    if (!content) continue;
    for (const b of docToBlocks(content.contentJson)) {
      const idx = b.text.toLowerCase().indexOf(q);
      if (idx !== -1) {
        matches.push({ kind: n.kind, id: n.id, title: n.title, blockId: b.blockId ?? undefined, snippet: snippetAround(b.text, idx, q.length) });
        if (matches.length >= limit) return { matches, truncated: true };
        break; // one hit per chapter is enough for discovery — agent can read_chapter for the rest
      }
    }
  }
  return { matches };
}

/** An element's accepted state-change patches across chapters (its evolution). */
async function getElementPatches(_ctx: AgentToolContext, elementId: string) {
  if (!elementId) throw new Error('get_element_patches requires elementId');
  const patches = await createElementPatchRepository().listByElement(elementId);
  return {
    patches: patches.map((p) => ({
      id: p.id,
      title: p.title,
      sourceChapter: p.sourceNodeTitle,
      sourceChapterId: p.sourceNodeId,
      body: docToPlainText(p.contentJson),
      createdAt: p.createdAt,
    })),
  };
}

/** Editorial threads / Copilot suggestions attached to an entity (or all). */
function listComments(ctx: AgentToolContext, args: Record<string, unknown>) {
  const kind = String(args.kind ?? '');
  const id = String(args.id ?? '');
  const s = useDataStore.getState();
  const rows = s.comments.filter(
    (c) =>
      c.projectId === ctx.projectId &&
      (!kind || c.targetKind === kind) &&
      (!id || c.targetId === id),
  );
  return {
    comments: rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      targetKind: c.targetKind,
      targetId: c.targetId,
      author: c.authorName ?? c.authorKind,
      status: c.status,
      body: docToPlainText(c.bodyJson),
    })),
  };
}

// ---- Write handlers --------------------------------------------------------
// All go through ctx.write (the usecases), so edits sync exactly like manual
// ones. NOTE: prose edits write the SAVED copy; if the chapter is currently
// open in the editor, the open editor may overwrite the change on its next
// save — close/save the chapter first.

async function updateElement(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.elementId ?? '');
  if (!id) throw new Error('update_element requires elementId');
  const updates: UpdateElementUsecaseInput = {};
  if (typeof args.name === 'string') updates.name = args.name;
  if (typeof args.summary === 'string') updates.summary = args.summary;
  if (Array.isArray(args.aliases)) {
    updates.aliases = args.aliases.filter((a): a is string => typeof a === 'string');
  }
  if (typeof args.groupName === 'string') updates.groupName = args.groupName;
  await ctx.write.updateElement(id, updates);
  return { ok: true, id };
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
  return { ok: true, created };
}

async function renameChapter(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const title = String(args.title ?? '');
  if (!nodeId || !title) throw new Error('rename_chapter requires nodeId and title');
  await ctx.write.renameNode(nodeId, title);
  return { ok: true, id: nodeId };
}

async function setNodeSummary(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  if (!nodeId) throw new Error('set_node_summary requires nodeId');
  await ctx.write.updateNode(nodeId, { summary: String(args.summary ?? '') });
  return { ok: true, id: nodeId };
}

async function editBlock(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const blockId = String(args.blockId ?? '');
  const text = String(args.text ?? '');
  if (!nodeId || !blockId) throw new Error('edit_block requires nodeId and blockId');
  const content = await createBookContentRepository().findByNodeId(nodeId);
  if (!content) throw new Error(`No content found for node "${nodeId}"`);
  const nextJson = replaceBlockText(content.contentJson, blockId, text);
  await ctx.write.updateContentByNodeId(nodeId, { contentJson: nextJson });
  return { ok: true, nodeId, blockId };
}

async function appendParagraphTool(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const text = String(args.text ?? '');
  if (!nodeId || !text) throw new Error('append_paragraph requires nodeId and text');
  const content = await createBookContentRepository().findByNodeId(nodeId);
  if (!content) throw new Error(`No content found for node "${nodeId}"`);
  const nextJson = appendParagraph(content.contentJson, text);
  await ctx.write.updateContentByNodeId(nodeId, { contentJson: nextJson });
  return { ok: true, nodeId };
}

// ---- Relationship handlers -------------------------------------------------

async function linkChapterToStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires nodeId and storylineId');
  await ctx.write.addNodeToStoryline(nodeId, storylineId);
  return { ok: true, nodeId, storylineId };
}

async function unlinkChapterFromStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires nodeId and storylineId');
  await ctx.write.removeNodeFromStoryline(nodeId, storylineId);
  return { ok: true, nodeId, storylineId };
}

async function setPrimaryStoryline(ctx: AgentToolContext, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId ?? '');
  const storylineId = String(args.storylineId ?? '');
  if (!nodeId || !storylineId) throw new Error('requires nodeId and storylineId');
  // Ensure membership, then mark it primary — setNodeStorylines replaces the
  // full set, so include the current memberships plus this one.
  const current = useDataStore.getState().nodeStorylineMapping[nodeId] ?? [];
  const ids = current.includes(storylineId) ? current : [...current, storylineId];
  await ctx.write.setNodeStorylines(nodeId, ids, { primaryStorylineId: storylineId });
  return { ok: true, nodeId, primaryStorylineId: storylineId };
}

async function addRelation(ctx: AgentToolContext, args: Record<string, unknown>) {
  const fromKind = String(args.fromKind ?? '');
  const fromId = String(args.fromId ?? '');
  const toKind = String(args.toKind ?? '');
  const toId = String(args.toId ?? '');
  if (!isEntityKind(fromKind)) throw new Error(`Invalid fromKind "${fromKind}"`);
  if (!isStructuralEntityKind(toKind)) {
    throw new Error(`Invalid toKind "${toKind}" (must be node/element/patch/category/storyline)`);
  }
  if (!fromId || !toId) throw new Error('add_relation requires fromId and toId');
  const kind = typeof args.kind === 'string' ? args.kind : undefined;
  const relation = await ctx.write.addRelation(fromKind, fromId, toKind, toId, { kind });
  return { ok: true, relation };
}

async function deleteElement(ctx: AgentToolContext, args: Record<string, unknown>) {
  const id = String(args.elementId ?? '');
  if (!id) throw new Error('delete_element requires elementId');
  const el = useDataStore.getState().bookElements.find((e) => e.id === id);
  const label = el ? el.name : id;
  // Destructive — require explicit human confirmation in the renderer.
  const confirmed =
    typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`Claude wants to delete the element "${label}". Allow?`)
      : false;
  if (!confirmed) return { ok: false, declined: true };
  await ctx.write.removeElement(id);
  return { ok: true, id };
}

/** Dispatch a tool call to its handler. Throws on unknown/missing. */
export async function runAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<unknown> {
  switch (name) {
    // reads
    case 'list_project_structure':
      return listProjectStructure(ctx);
    case 'read_chapter':
      return readChapter(ctx, String(args.nodeId ?? ''));
    case 'read_element':
      return readElement(ctx, String(args.elementId ?? ''));
    case 'search_project':
      return searchProject(ctx, String(args.query ?? ''));
    // relational / context reads (point → surface)
    case 'get_project_brief':
      return getProjectBrief(ctx);
    case 'where_does_entity_appear':
      return whereDoesEntityAppear(ctx, args);
    case 'get_entity_relations':
      return getEntityRelations(ctx, args);
    case 'get_storyline':
      return getStoryline(ctx, String(args.storylineId ?? ''));
    case 'get_chapter_context':
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
    case 'create_element':
      return createElement(ctx, args);
    case 'rename_chapter':
      return renameChapter(ctx, args);
    case 'set_node_summary':
      return setNodeSummary(ctx, args);
    case 'edit_block':
      return editBlock(ctx, args);
    case 'append_paragraph':
      return appendParagraphTool(ctx, args);
    // relationships
    case 'link_chapter_to_storyline':
      return linkChapterToStoryline(ctx, args);
    case 'unlink_chapter_from_storyline':
      return unlinkChapterFromStoryline(ctx, args);
    case 'set_primary_storyline':
      return setPrimaryStoryline(ctx, args);
    case 'add_relation':
      return addRelation(ctx, args);
    // destructive
    case 'delete_element':
      return deleteElement(ctx, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
