/**
 * Renderer-side execution of the agent's entity tools.
 *
 * Reads come from the live in-memory data store (single-project) plus the
 * content repo for prose. Everything is scoped to the active project. P1 is
 * read-only; write handlers are added in P2 and call the usecases so agent
 * edits go through the same optimistic-update + sync path as manual edits.
 */
import { useDataStore } from '../../store/data-store';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { isChapter, type BookNode } from '../../domain/book-node';
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
