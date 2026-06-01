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
  // Compact JSON (no pretty-print) — the model doesn't need indentation, and it
  // saves the whitespace tokens on every read. Strings pass through verbatim.
  const text = typeof data === 'string' ? data : JSON.stringify(data);
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
        'list_chapters',
        "List the project's storylines (name + summary), chapters (name · status · words · storyline), and drift notes — BY NAME. Names are project-unique, so use them directly as the `nodeId`/`storylineId` arg of the read/edit tools (no ids needed). Call this to see the manuscript's structure.",
        {},
        () => run('list_chapters', {}),
      ),
      tool(
        'list_elements',
        "List the project's element categories and elements (character / setting / item) BY NAME (name · category · summary). Names are project-unique, so use them directly as the `elementId`/`categoryId` arg of the read/edit tools. Use this instead of list_chapters when you only need elements.",
        {},
        () => run('list_elements', {}),
      ),
      tool(
        'read_chapter',
        "Read a chapter/drift's prose as a compact numbered list: a header line (title · status · words · id), a summary line, an `appears:` line naming the elements/entities mentioned in this chapter, then one block per line as `<n>\\t<text>` (non-paragraph blocks prefixed by type, e.g. '# ' heading, '> ' quote). Pass the leading number <n> to edit_block to edit that block.",
        { nodeId: z.string().describe('Chapter/drift NAME (preferred) or id') },
        (args) => run('read_chapter', args),
      ),
      tool(
        'read_element',
        'Read an element (character / setting / item): its name, summary, aliases, group, and body text.',
        { elementId: z.string().describe('Element NAME (preferred) or id') },
        (args) => run('read_element', args),
      ),
      tool(
        'search_project',
        'Fast metadata search across chapter/drift titles, element names/summaries/aliases, and storyline names (no prose body). Returns matching {kind, label} where label is the (unique) name — pass it straight to the read/edit tools. For searching inside prose text use search_prose.',
        { query: z.string().describe('Text to search for') },
        (args) => run('search_project', args),
      ),
      tool(
        'resolve_entity',
        'Resolve an entity NAME to its id (exact, case-insensitive) so you can address things by name instead of long uuids. Names are kept project-unique, so this returns a single {id,kind,label}; if a name is unexpectedly ambiguous it returns {ambiguous:[…]} — pick by kind. Returns {found:false} if no match.',
        {
          name: z.string().describe('The exact entity name/title'),
          kind: z
            .string()
            .optional()
            .describe('Restrict to a kind: element / node (chapter|drift) / storyline / category'),
        },
        (args) => run('resolve_entity', args),
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
        { storylineId: z.string().describe('Storyline NAME (preferred) or id') },
        (args) => run('get_storyline', args),
      ),
      tool(
        'get_chapter_context',
        "Cheap overview of a chapter WITHOUT its full prose: title, summary, word count, status, rolling block-section summaries, the elements it references, the storylines it belongs to, and its relations. Call this before read_chapter — only read the full prose if you still need it.",
        { nodeId: z.string().describe('Chapter/drift NAME (preferred) or id') },
        (args) => run('get_chapter_context', args),
      ),
      tool(
        'search_prose',
        'Case-insensitive full-text search INSIDE chapter/drift prose and element bodies. Returns {kind, title, block, snippet} where title is the (unique) name — pass it as nodeId/elementId — and block is the 1-based block number (pass it to edit_block / read_chapter). Heavier than search_project — use it to find scenes/passages by content.',
        {
          query: z.string().describe('Text to find in the prose'),
          limit: z.number().optional().describe('Max matches (default 30, cap 100)'),
        },
        (args) => run('search_prose', args),
      ),
      tool(
        'get_element_patches',
        "An element's accepted state-change patches across chapters (how a character/place/item evolves over the book), each with its source chapter and body text.",
        { elementId: z.string().describe('Element NAME (preferred) or id') },
        (args) => run('get_element_patches', args),
      ),
      tool(
        'list_comments',
        "Editorial notes & TODOs (and Copilot suggestions). Pass a target (kind,id) to scope to one entity, or omit both for all comments in the project. Returns each as {id, kind (note|todo), targetKind, targetId, targetBlockId, body, quote, status}. For a TODO anchored to a block (targetKind='node' with a targetBlockId), call read_block(targetId, targetBlockId) to get the block's LIVE text (the `quote` is a creation-time snapshot and may be stale); if there's no targetBlockId, search_prose for the `quote` within targetId to relocate the passage.",
        {
          kind: z.string().optional().describe('Target kind to filter by (optional)'),
          id: z.string().optional().describe('Target id to filter by (optional)'),
        },
        (args) => run('list_comments', args),
      ),
      tool(
        'read_block',
        "Read the CURRENT (live) text of one prose block by its uuid — e.g. a TODO's targetBlockId from list_comments. Returns {found, block (1-based number), type, text} so you can then edit_block it. Returns {found:false} if that block was since deleted.",
        {
          nodeId: z.string().describe('The chapter/drift node id (a comment’s targetId)'),
          blockId: z.string().describe('The block uuid (e.g. a comment’s targetBlockId)'),
        },
        (args) => run('read_block', args),
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
        'Create a new element (character / place / item) under a category. categoryId is required — pass the category NAME (from list_elements) or create_category first.',
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
        'Replace the text of ONE prose block, keeping it in place. Address it by its number (from read_chapter / search_prose) via `block`, or by uuid via `blockId` (e.g. from where_does_entity_appear). To change several blocks in the same chapter, use edit_blocks instead (atomic). Inline formatting in that block is dropped. Edits apply to the chapter live — if it is open in the editor, the change appears immediately.',
        {
          nodeId: z.string(),
          block: z.number().optional().describe('1-based block number from read_chapter'),
          blockId: z.string().optional().describe('uuid block id (alternative to block)'),
          text: z.string(),
        },
        (args) => run('edit_block', args),
      ),
      tool(
        'edit_blocks',
        'Replace the text of SEVERAL prose blocks in one chapter atomically (one read-modify-write — safe against clobbering, one round-trip). Use this instead of multiple edit_block calls on the same chapter. Each edit addresses a block by `block` (number) or `blockId` (uuid). Block numbers refer to read_chapter and stay valid across the batch.',
        {
          nodeId: z.string(),
          edits: z
            .array(
              z.object({
                block: z.number().optional(),
                blockId: z.string().optional(),
                text: z.string(),
              }),
            )
            .describe('Blocks to replace, each {block|blockId, text}'),
        },
        (args) => run('edit_blocks', args),
      ),
      tool(
        'append_paragraph',
        'Append a new paragraph to the end of a chapter/drift node.',
        { nodeId: z.string(), text: z.string() },
        (args) => run('append_paragraph', args),
      ),
      tool(
        'lookup_block',
        "Find a prose block's stable uuid `blockId` by its 1-based number and/or a substring of its text. Use this to get the blockId needed by the structural tools below (remove_blocks / replace_block_range / insert_blocks), since read_chapter's numbers shift once blocks are added or removed. Returns matches as {blockId, block, type, snippet}.",
        {
          nodeId: z.string(),
          ordinal: z.number().optional().describe('1-based block number from read_chapter'),
          contains: z.string().optional().describe('case-insensitive substring of the block text'),
        },
        (args) => run('lookup_block', args),
      ),
      tool(
        'remove_blocks',
        'Delete one or more prose blocks from a chapter/drift. Addressed by stable uuid `blockId` ONLY (get them from lookup_block / where_does_entity_appear) — never by number, which shifts after a structural edit. Destructive; confirm intent before removing prose.',
        {
          nodeId: z.string(),
          blockIds: z.array(z.string()).describe('uuid block ids to delete'),
        },
        (args) => run('remove_blocks', args),
      ),
      tool(
        'replace_block_range',
        'Replace an inclusive range of blocks [fromBlockId … toBlockId] with new paragraphs (one per string in `blocks`; pass [] to just delete the range). The replacement may have a different number of blocks than the original. Range endpoints are addressed by uuid `blockId` (from lookup_block), not by number. New blocks are plain paragraphs with fresh ids.',
        {
          nodeId: z.string(),
          fromBlockId: z.string().describe('uuid of the first block in the range'),
          toBlockId: z.string().describe('uuid of the last block in the range (may equal fromBlockId)'),
          blocks: z.array(z.string()).describe('replacement paragraphs, one string each'),
        },
        (args) => run('replace_block_range', args),
      ),
      tool(
        'insert_blocks',
        'Insert new paragraphs into a chapter/drift after a given block (by uuid `afterBlockId`), or at the very start when afterBlockId is omitted. Each string becomes one new paragraph with a fresh id. To add at the very end use append_paragraph.',
        {
          nodeId: z.string(),
          afterBlockId: z
            .string()
            .optional()
            .describe('uuid of the block to insert after; omit to prepend at the start'),
          blocks: z.array(z.string()).describe('new paragraphs, one string each'),
        },
        (args) => run('insert_blocks', args),
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
        "Rename a storyline, set its summary, or set its kv `facts` (merged by key — e.g. this thread's tone/focus). facts the agent sets are surfaced by get_storyline.",
        {
          storylineId: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          facts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('key/value facts to upsert (merged with existing, by key)'),
        },
        (args) => run('update_storyline', args),
      ),
      tool(
        'create_category',
        'Create a new element category (e.g. 人物 / 地点 / 物件). Then create elements under it with create_element.',
        { name: z.string().optional() },
        (args) => run('create_category', args),
      ),
      tool(
        'update_category',
        "Set/update a category's element TEMPLATE facts (templateFacts) — the kv seeded into NEW elements of this category (e.g. a 人物 template with empty 年龄/外貌 fields). NOT the category's own metadata. Merged by key.",
        {
          categoryId: z.string(),
          templateFacts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .describe('template key/value facts to upsert (merged by key)'),
        },
        (args) => run('update_category', args),
      ),
      tool(
        'update_project_facts',
        "Set/update the PROJECT's key/value facts — the book-level metadata the agent treats as governing constraints (文风/写作风格, 写作人称/POV, 章节目标字数, 本书目标, 对标作品, …). Merged by key, so setting one fact preserves the author's others. Use this to record style/voice/POV decisions you make with the user so they persist and steer future writing.",
        {
          facts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .describe('key/value facts to upsert (merged with existing project facts, by key)'),
        },
        (args) => run('update_project_facts', args),
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
      // ---- summary (reverse-generate: read the content yourself, then write) ----
      tool(
        'set_summary',
        "Write a summary onto an entity. To (re)generate a summary, read the content first (get_chapter_context / read_chapter / read_element) then call this. targetKind is node (chapter/drift) / element / storyline.",
        {
          targetKind: z.string().describe('node / element / storyline'),
          targetId: z.string(),
          summary: z.string(),
        },
        (args) => run('set_summary', args),
      ),
      // ---- element patches (a character/place/item's per-chapter state change) ----
      tool(
        'create_element_patch',
        "Record a state-change patch for an element (how it changes at a point in the story). body is the patch prose; optionally anchor it to the chapter where the change happens via sourceNodeId.",
        {
          elementId: z.string(),
          title: z.string().optional(),
          body: z.string().optional().describe('The patch text'),
          sourceNodeId: z.string().optional().describe('Chapter where this change occurs'),
        },
        (args) => run('create_element_patch', args),
      ),
      tool(
        'update_element_patch',
        'Update an element patch (by patchId from get_element_patches). Only provided fields change.',
        { patchId: z.string(), title: z.string().optional(), body: z.string().optional() },
        (args) => run('update_element_patch', args),
      ),
      tool(
        'delete_element_patch',
        'Delete an element patch by patchId.',
        { patchId: z.string() },
        (args) => run('delete_element_patch', args),
      ),
      // ---- comments / TODOs (a TODO is a comment with kind='todo') ----
      tool(
        'create_comment',
        "Create a comment or TODO. kind='note' is an editor annotation, kind='todo' shows in the right-sidebar TODO list. Attach it to an entity via targetKind/targetId (and targetBlockId for a specific prose block), or omit all targets for a floating project-level TODO.",
        {
          body: z.string().describe('The comment / TODO text'),
          kind: z.string().optional().describe("'note' (default) or 'todo'"),
          targetKind: z.string().optional().describe('node / element / storyline / …'),
          targetId: z.string().optional(),
          targetBlockId: z.string().optional(),
        },
        (args) => run('create_comment', args),
      ),
      tool(
        'delete_comment',
        'Delete a comment / TODO by commentId (from list_comments).',
        { commentId: z.string() },
        (args) => run('delete_comment', args),
      ),
      tool(
        'set_comment_status',
        "Resolve or reopen a comment / TODO. status is 'resolved' or 'open'.",
        { commentId: z.string(), status: z.string() },
        (args) => run('set_comment_status', args),
      ),
      tool(
        'set_comment_kind',
        "Convert a comment between a note and a TODO. kind is 'todo' or 'note'.",
        { commentId: z.string(), kind: z.string() },
        (args) => run('set_comment_kind', args),
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
