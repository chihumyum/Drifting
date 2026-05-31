/**
 * The Drifting in-process MCP server exposed to the agent.
 *
 * Every tool handler is a thin bridge to the renderer (see bridge.ts) — the
 * real read/write happens there against the live store + usecases. P1 ships
 * read-only tools; writes/relationships arrive in P2/P3.
 */
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { callRenderer } from './bridge';

type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function asText(data: unknown): ToolContent {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function asError(err: unknown): ToolContent {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

export async function createDriftingMcpServer(getWindow: () => BrowserWindow | null) {
  const { createSdkMcpServer, tool } = await import(
    /* @vite-ignore */ '@anthropic-ai/claude-agent-sdk'
  );

  const run = (name: string, args: Record<string, unknown>): Promise<ToolContent> =>
    callRenderer(getWindow, name, args).then(asText, asError);

  return createSdkMcpServer({
    name: 'drifting',
    tools: [
      tool(
        'list_project_structure',
        "List the project's chapters, drift notes, storylines, element categories, and elements (ids + names). Call this FIRST to discover ids before reading anything.",
        {},
        () => run('list_project_structure', {}),
      ),
      tool(
        'read_chapter',
        "Read a chapter or drift node's prose, returned block-by-block (each block has a blockId you can later target for edits) plus its title and summary.",
        { nodeId: z.string().describe('Node id from list_project_structure') },
        (args) => run('read_chapter', args),
      ),
      tool(
        'read_element',
        'Read an element (character / setting / item): its name, summary, aliases, group, and body text.',
        { elementId: z.string().describe('Element id from list_project_structure') },
        (args) => run('read_element', args),
      ),
      tool(
        'search_project',
        'Fast metadata search across chapter/drift titles, element names/summaries/aliases, and storyline names (no prose body). Returns matching {kind,id,label}. For searching inside prose text use search_prose.',
        { query: z.string().describe('Text to search for') },
        (args) => run('search_project', args),
      ),
      // ---- relational / context reads (traverse the graph, don't brute-force) ----
      tool(
        'get_project_brief',
        "The book's premise: project name, description, the author's key/value facts (goal, style, premise, references) and structure counts. Call this FIRST to orient before diving in.",
        {},
        () => run('get_project_brief', {}),
      ),
      tool(
        'where_does_entity_appear',
        'Find every chapter/drift (and other source) where a structural entity is mentioned in prose — its appearances/backlinks. The fastest way to go from one character/place/item to all the scenes involving it. Returns appearances grouped by source with blockIds.',
        {
          kind: z
            .string()
            .describe('Target kind: element / node / storyline / category / patch'),
          id: z.string().describe('Target entity id'),
        },
        (args) => run('where_does_entity_appear', args),
      ),
      tool(
        'get_entity_relations',
        'List the curated cross-entity relation edges touching an entity, both directions (outgoing + incoming), e.g. ally-of / belongs-to / located-in. Use to walk the author-defined story graph.',
        {
          kind: z.string().describe('Entity kind (element/node/storyline/category/...)'),
          id: z.string().describe('Entity id'),
        },
        (args) => run('get_entity_relations', args),
      ),
      tool(
        'get_storyline',
        "A storyline's summary, key/value facts, and its member chapters in reading order (with which one is primary).",
        { storylineId: z.string().describe('Storyline id from list_project_structure') },
        (args) => run('get_storyline', args),
      ),
      tool(
        'get_chapter_context',
        "Cheap overview of a chapter WITHOUT its full prose: title, summary, word count, status, rolling block-section summaries, the elements it references, the storylines it belongs to, and its relations. Call this before read_chapter — only read the full prose if you still need it.",
        { nodeId: z.string().describe('Chapter/drift node id') },
        (args) => run('get_chapter_context', args),
      ),
      tool(
        'search_prose',
        'Case-insensitive full-text search INSIDE chapter/drift prose and element bodies. Returns {kind,id,title,blockId,snippet} with a short context snippet around each hit. Heavier than search_project — use it to find scenes/passages by content.',
        {
          query: z.string().describe('Text to find in the prose'),
          limit: z.number().optional().describe('Max matches (default 30, cap 100)'),
        },
        (args) => run('search_prose', args),
      ),
      tool(
        'get_element_patches',
        "An element's accepted state-change patches across chapters (how a character/place/item evolves over the book), each with its source chapter and body text.",
        { elementId: z.string().describe('Element id') },
        (args) => run('get_element_patches', args),
      ),
      tool(
        'list_comments',
        'Editorial threads and Copilot suggestions. Pass a target (kind,id) to scope to one entity, or omit both for all comments in the project. Returns {kind,target,author,status,body}.',
        {
          kind: z.string().optional().describe('Target kind to filter by (optional)'),
          id: z.string().optional().describe('Target id to filter by (optional)'),
        },
        (args) => run('list_comments', args),
      ),
      // ---- writes ----
      tool(
        'update_element',
        "Update an element's fields. Only provided fields change. Pass categoryId to move the element to another category; pass facts to replace its structured key/value facts.",
        {
          elementId: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          groupName: z.string().optional(),
          categoryId: z.string().optional().describe('Move the element to this category'),
          facts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Replaces the element\'s structured facts (kv)'),
        },
        (args) => run('update_element', args),
      ),
      tool(
        'create_element',
        'Create a new element (character / place / item) under a category. categoryId is required (get it from list_project_structure, or create_category first).',
        {
          categoryId: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          facts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Structured key/value facts for the new element'),
        },
        (args) => run('create_element', args),
      ),
      tool(
        'rename_chapter',
        'Rename a chapter or drift node.',
        { nodeId: z.string(), title: z.string() },
        (args) => run('rename_chapter', args),
      ),
      tool(
        'set_node_summary',
        "Set a chapter/drift node's summary.",
        { nodeId: z.string(), summary: z.string() },
        (args) => run('set_node_summary', args),
      ),
      tool(
        'edit_block',
        'Replace the text of one prose block (by blockId from read_chapter), keeping the block in place. Inline formatting in that block is dropped. If the chapter is open in the editor, save/close it first.',
        { nodeId: z.string(), blockId: z.string(), text: z.string() },
        (args) => run('edit_block', args),
      ),
      tool(
        'append_paragraph',
        'Append a new paragraph to the end of a chapter/drift node.',
        { nodeId: z.string(), text: z.string() },
        (args) => run('append_paragraph', args),
      ),
      // ---- relationships ----
      tool(
        'link_chapter_to_storyline',
        'Add a chapter (node) as a member of a storyline.',
        { nodeId: z.string(), storylineId: z.string() },
        (args) => run('link_chapter_to_storyline', args),
      ),
      tool(
        'unlink_chapter_from_storyline',
        'Remove a chapter (node) from a storyline.',
        { nodeId: z.string(), storylineId: z.string() },
        (args) => run('unlink_chapter_from_storyline', args),
      ),
      tool(
        'set_primary_storyline',
        "Make a storyline the chapter's primary storyline (adds membership if needed).",
        { nodeId: z.string(), storylineId: z.string() },
        (args) => run('set_primary_storyline', args),
      ),
      tool(
        'add_relation',
        'Create a curated cross-entity relation (story-graph edge), e.g. ally-of / belongs-to / located-in. fromKind is one of node/element/patch/category/storyline/comment/library_item; toKind must be structural (node/element/patch/category/storyline). Reuse an existing "kind" label (see get_entity_relations) for consistency.',
        {
          fromKind: z.string(),
          fromId: z.string(),
          toKind: z.string(),
          toId: z.string(),
          kind: z.string().optional().describe('Free-form relation label (reuse existing ones)'),
        },
        (args) => run('add_relation', args),
      ),
      tool(
        'remove_relation',
        'Delete a curated relation edge by its relationId (from get_entity_relations).',
        { relationId: z.string() },
        (args) => run('remove_relation', args),
      ),
      tool(
        'update_relation_kind',
        'Relabel a curated relation edge (by relationId). Pass kind = null/"" to clear the label.',
        { relationId: z.string(), kind: z.string().optional() },
        (args) => run('update_relation_kind', args),
      ),
      // ---- entity creation (containers to relate into) ----
      tool(
        'create_storyline',
        'Create a new storyline (plot thread). Then link chapters to it with link_chapter_to_storyline / set_primary_storyline.',
        { name: z.string().optional(), summary: z.string().optional() },
        (args) => run('create_storyline', args),
      ),
      tool(
        'update_storyline',
        "Rename a storyline or set its summary.",
        { storylineId: z.string(), name: z.string().optional(), summary: z.string().optional() },
        (args) => run('update_storyline', args),
      ),
      tool(
        'create_category',
        'Create a new element category (e.g. 人物 / 地点 / 物件). Then create elements under it with create_element.',
        { name: z.string().optional() },
        (args) => run('create_category', args),
      ),
      tool(
        'create_node',
        "Create a new chapter or drift node. kind is 'chapter' (sits on the reading order, optionally linked to a storyline) or 'drift' (free-floating note).",
        {
          kind: z.string().describe("'chapter' or 'drift'"),
          title: z.string().optional(),
          storylineId: z.string().optional().describe('For chapters: the primary storyline to link'),
        },
        (args) => run('create_node', args),
      ),
      // ---- destructive (asks the user to confirm in the app) ----
      tool(
        'delete_element',
        'Delete an element. The app will ask the user to confirm before deleting; returns {declined:true} if they refuse.',
        { elementId: z.string() },
        (args) => run('delete_element', args),
      ),
    ],
  });
}
