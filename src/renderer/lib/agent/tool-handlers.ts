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
import { isChapter } from '../../domain/book-node';
import { docToBlocks, docToPlainText } from './serialize';

export interface AgentToolContext {
  projectId: string;
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

/** Dispatch a tool call to its read handler. Throws on unknown/missing. */
export async function runAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<unknown> {
  switch (name) {
    case 'list_project_structure':
      return listProjectStructure(ctx);
    case 'read_chapter':
      return readChapter(ctx, String(args.nodeId ?? ''));
    case 'read_element':
      return readElement(ctx, String(args.elementId ?? ''));
    case 'search_project':
      return searchProject(ctx, String(args.query ?? ''));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
