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

  // Shared target selector for the block-prose tools. Prose blocks live not only
  // in chapters/drift nodes but also in element / storyline / category bodies —
  // pass `kind` to address those; it defaults to node (chapter/drift). `entity`
  // is the project-unique NAME. (The handler also accepts the legacy `node`
  // spelling for back-compat.)
  const proseTarget = {
    kind: z
      .string()
      .optional()
      .describe('Entity kind to edit: node (chapter/drift — the default) | element | storyline | category'),
    entity: z
      .string()
      .describe('Entity NAME: the chapter/drift, element, storyline, or category to read/edit'),
  };

  return createSdkMcpServer({
    name: 'drifting',
    tools: [
      tool(
        'list_nodes',
        "List the project's storylines (name + summary), chapters (name · status · words · storyline), and drift notes — BY NAME. A 'node' is a chapter OR a drift; they share one name space, so a node name is unambiguous. Names are project-unique, so use them directly as the `node`/`storyline` arg of the read/edit tools (no ids needed). Call this to see the manuscript's structure.",
        {},
        () => run('list_nodes', {}),
      ),
      tool(
        'list_elements',
        "List the project's element categories and elements (character / setting / item) BY NAME (name · category · summary). Names are project-unique, so use them directly as the `element`/`category` arg of the read/edit tools. Use this instead of list_nodes when you only need elements.",
        {},
        () => run('list_elements', {}),
      ),
      tool(
        'read_node',
        "Read a prose body as a compact numbered list, one block per line as `<n>\\t<text>` (non-paragraph blocks prefixed by type, e.g. '# ' heading, '> ' quote); pass the leading number <n> to edit_block (and to the structural tools). For a chapter/drift node it also prefixes the chapter's context inline — a header line (title · status · words), `summary:`, `appears:` (elements mentioned), and, when present, `storylines:` and `relations:`. Pass `prose:false` to get JUST that header (no body) — the cheap way to TRIAGE a chapter's summary/appears/storylines/relations without pulling its full text. Set `kind` to read an element / storyline / category body instead (body-only, no header).",
        {
          ...proseTarget,
          prose: z
            .boolean()
            .optional()
            .describe('Include the prose body (default true); pass false for a prose-free, header-only overview'),
        },
        (args) => run('read_node', args),
      ),
      tool(
        'read_element',
        'Read an element (character / setting / item): its name, summary, aliases, group, category and body text.',
        { element: z.string().describe('Element NAME') },
        (args) => run('read_element', args),
      ),
      tool(
        'search_project',
        'Fast metadata search across chapter/drift titles, element names/summaries/aliases, and storyline names (no prose body). Returns matching {kind, label} where label is the (unique) name — pass it straight to the read/edit tools. For searching inside prose text use search_prose.',
        { query: z.string().describe('Text to search for') },
        (args) => run('search_project', args),
      ),
      // ---- relational / context reads (traverse the graph, don't brute-force) ----
      tool(
        'get_overview',
        "Orient in ONE call: the book's premise + author facts + counts, ALL storylines/chapters/drifts, and ALL element categories/elements — everything by NAME. Call this FIRST instead of get_project_brief + list_nodes + list_elements separately. (Those three still exist to re-fetch a single slice.)",
        {},
        () => run('get_overview', {}),
      ),
      tool(
        'get_project_brief',
        "The book's premise: project name, description, the author's key/value facts (goal, style, premise, references) and structure counts. Usually folded into get_overview — call this alone only to re-read the premise.",
        {},
        () => run('get_project_brief', {}),
      ),
      tool(
        'where_does_entity_appear',
        'Find every chapter/drift (and other source) where a structural entity is mentioned in prose — its appearances/backlinks. The fastest way to go from one character/place/item to all the scenes involving it. Returns appearances grouped by source (by name) with a per-source mentionCount and a few context snippets (the matched name wrapped in 「」), plus totalMentions. Each snippet carries its blockId for a follow-up read_block / edit; `more` counts extra blocks beyond the shown snippets.',
        {
          kind: z
            .string()
            .describe('Target kind: element / node / storyline / category / patch'),
          name: z.string().describe('Target entity NAME'),
        },
        (args) => run('where_does_entity_appear', args),
      ),
      tool(
        'get_entity_relations',
        'List the curated cross-entity relation edges touching an entity, both directions (outgoing + incoming), e.g. ally-of / belongs-to / located-in. Use to walk the author-defined story graph. Each edge carries a relationId — the handle for remove_relation / update_relation_kind.',
        {
          kind: z.string().describe('Entity kind (element/node/storyline/category/...)'),
          name: z.string().describe('Entity NAME'),
        },
        (args) => run('get_entity_relations', args),
      ),
      tool(
        'get_storyline',
        "A storyline's summary, key/value facts, and its member chapters in reading order (with which one is primary).",
        { storyline: z.string().describe('Storyline NAME (or id)') },
        (args) => run('get_storyline', args),
      ),
      tool(
        'search_prose',
        'Case-insensitive full-text search INSIDE chapter/drift prose and element bodies. Returns {kind, title, block, snippet} where title is the (unique) name — pass it as the node/element arg — and block is the 1-based block number (pass it to edit_block / read_node). Heavier than search_project — use it to find scenes/passages by content.',
        {
          query: z.string().describe('Text to find in the prose'),
          limit: z.number().optional().describe('Max matches (default 30, cap 100)'),
        },
        (args) => run('search_prose', args),
      ),
      tool(
        'get_element_patches',
        "An element's accepted state-change patches across chapters (how a character/place/item evolves over the book), each with its source chapter (by name) and body text. Each carries a patchId — the handle for update_element_patch / delete_element_patch.",
        { element: z.string().describe('Element NAME') },
        (args) => run('get_element_patches', args),
      ),
      tool(
        'list_comments',
        "Editorial notes & TODOs (and Copilot suggestions). Scope to one entity by passing (kind, entity) where entity is the entity NAME; scoping matches BOTH comments anchored via the target fields AND comments linked to that entity by a relation edge (e.g. TODOs created from the right sidebar). Omit both to list every comment. Optional filters: onlyTodos (just kind='todo') and status ('open'/'resolved') — use these to pull the open TODO worklist. Returns each as {id, kind (note|todo), targetKind, target, targetBlockId, relatedTo, body, quote, status}. `target` is the NAME of the entity the comment is anchored to; `relatedTo` names the entities the comment is linked to (this is how a floating TODO tells you which chapter/element it's about). For a TODO anchored to a block (targetKind='node' with a targetBlockId), call read_block(node=target, blockId=targetBlockId) for the block's LIVE text (the `quote` is a creation-time snapshot, may be stale); if there's no targetBlockId, use `relatedTo` or search_prose for the `quote` to locate the passage. `id` is the commentId — the handle for set_comment_status / set_comment_kind / delete_comment.",
        {
          kind: z
            .string()
            .optional()
            .describe('Scope target kind: node (chapter/drift) / element / storyline / category'),
          entity: z.string().optional().describe('Scope target entity NAME'),
          onlyTodos: z.boolean().optional().describe("Only return TODOs (kind='todo')"),
          status: z.string().optional().describe("Filter by status: 'open' or 'resolved'"),
        },
        (args) => run('list_comments', args),
      ),
      tool(
        'read_block',
        "Read the CURRENT (live) text of one prose block by its uuid — e.g. a TODO's targetBlockId from list_comments. Returns {found, block (1-based number), type, text} so you can then edit_block it. Returns {found:false} if that block was since deleted. Set `kind` for an element/storyline/category block.",
        {
          ...proseTarget,
          blockId: z.string().describe("The block uuid (e.g. a comment's targetBlockId)"),
        },
        (args) => run('read_block', args),
      ),
      // ---- writes ----
      tool(
        'update_element',
        "Update an element's fields. Only provided fields change. Pass category to move the element to another category; pass facts to replace its structured key/value facts.",
        {
          element: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          groupName: z.string().optional(),
          category: z.string().optional().describe('Move the element to this category (NAME)'),
          facts: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Replaces the element\'s structured facts (kv)'),
        },
        (args) => run('update_element', args),
      ),
      tool(
        'set_entity_body',
        "Replace the ENTIRE body/profile prose of an element, storyline, or category (the long-form description — distinct from an element's one-line `summary` and its kv `facts`). Pass the full new body as plain text; blank lines separate paragraphs. Read the current body first (read_element, or read_node with the matching kind). Inline formatting is dropped; this overwrites the whole body, so include everything you want to keep. NOT for chapters/drift — use the block tools there. For surgical edits to a LONG body prefer the block tools (edit_block / insert_blocks); a whole-body replace marks every paragraph changed.",
        {
          kind: z
            .string()
            .describe('Entity kind: element | storyline | category (NOT node — use the block tools for chapters)'),
          entity: z.string().describe('Entity NAME'),
          body: z.string().describe('The full new body text (replaces the existing body)'),
        },
        (args) => run('set_entity_body', args),
      ),
      tool(
        'create_element',
        'Create a new element (character / place / item) under a category. The category arg is required — pass the category NAME (from list_elements) or create_category first.',
        {
          category: z.string(),
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
        'rename_node',
        'Rename a chapter or drift node.',
        { node: z.string().describe('Node NAME (chapter or drift)'), title: z.string() },
        (args) => run('rename_node', args),
      ),
      tool(
        'set_node_summary',
        "Set a chapter/drift node's summary.",
        { node: z.string().describe('Node NAME (chapter or drift)'), summary: z.string() },
        (args) => run('set_node_summary', args),
      ),
      tool(
        'edit_block',
        'Replace the text of ONE prose block, keeping it in place. Address it by its number (from read_node / search_prose) via `block`, or by uuid via `blockId` (e.g. from where_does_entity_appear). To change several blocks in the same entity, use edit_blocks instead (atomic). Inline formatting in that block is dropped. Edits apply live — if the entity is open in the editor, the change appears immediately. Works on element/storyline/category bodies too — set `kind`.',
        {
          ...proseTarget,
          block: z.number().optional().describe('1-based block number from read_node'),
          blockId: z.string().optional().describe('uuid block id (alternative to block)'),
          text: z.string(),
        },
        (args) => run('edit_block', args),
      ),
      tool(
        'edit_blocks',
        'Replace the text of SEVERAL prose blocks in one entity atomically (one read-modify-write — safe against clobbering, one round-trip). Use this instead of multiple edit_block calls on the same entity. Each edit addresses a block by `block` (number) or `blockId` (uuid). Block numbers refer to read_node and stay valid across the batch. Set `kind` for an element/storyline/category body.',
        {
          ...proseTarget,
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
        'Append a new paragraph to the end of a prose body (chapter/drift node by default; set `kind` for an element/storyline/category body).',
        { ...proseTarget, text: z.string() },
        (args) => run('append_paragraph', args),
      ),
      tool(
        'lookup_block',
        "Find a prose block's stable uuid `blockId` by its 1-based number and/or a substring of its text. Use this to get the blockId needed by the structural tools below (remove_blocks / replace_block_range / insert_blocks), since read_node's numbers shift once blocks are added or removed. Returns matches as {blockId, block, type, snippet}. Set `kind` for an element/storyline/category body.",
        {
          ...proseTarget,
          ordinal: z.number().optional().describe('1-based block number from read_node'),
          contains: z.string().optional().describe('case-insensitive substring of the block text'),
        },
        (args) => run('lookup_block', args),
      ),
      tool(
        'remove_blocks',
        'Delete one or more prose blocks from a prose body (chapter/drift by default; set `kind` for an element/storyline/category body). Address blocks by their read_node NUMBER via `blockNumbers` (resolved against the current doc at call time — no lookup_block needed) and/or by stable uuid via `blockIds` (from lookup_block / where_does_entity_appear). Destructive; confirm intent before removing prose.',
        {
          ...proseTarget,
          blockNumbers: z
            .array(z.number())
            .optional()
            .describe('1-based block numbers from read_node'),
          blockIds: z
            .array(z.string())
            .optional()
            .describe('uuid block ids (alternative/in addition to blockNumbers)'),
        },
        (args) => run('remove_blocks', args),
      ),
      tool(
        'replace_block_range',
        'Replace an inclusive range of blocks with new paragraphs (one per string in `blocks`; pass [] to just delete the range). The replacement may have a different block count than the original. Address the range endpoints by read_node NUMBER via `fromBlock`/`toBlock` (resolved at call time — no lookup_block needed) or by uuid via `fromBlockId`/`toBlockId`. New blocks are plain paragraphs with fresh ids. Set `kind` for an element/storyline/category body.',
        {
          ...proseTarget,
          fromBlock: z.number().optional().describe('1-based number of the first block (from read_node)'),
          toBlock: z.number().optional().describe('1-based number of the last block (may equal fromBlock)'),
          fromBlockId: z.string().optional().describe('uuid of the first block (alternative to fromBlock)'),
          toBlockId: z.string().optional().describe('uuid of the last block (alternative to toBlock)'),
          blocks: z.array(z.string()).describe('replacement paragraphs, one string each'),
        },
        (args) => run('replace_block_range', args),
      ),
      tool(
        'insert_blocks',
        'Insert new paragraphs into a prose body after a given block — by read_node NUMBER via `afterBlock` (resolved at call time — no lookup_block needed) or by uuid via `afterBlockId`; omit both to prepend at the start. Each string becomes one new paragraph with a fresh id. To add at the very end use append_paragraph. Chapter/drift by default; set `kind` for an element/storyline/category body.',
        {
          ...proseTarget,
          afterBlock: z
            .number()
            .optional()
            .describe('1-based number of the block to insert after (from read_node)'),
          afterBlockId: z
            .string()
            .optional()
            .describe('uuid of the block to insert after (alternative to afterBlock); omit both to prepend'),
          blocks: z.array(z.string()).describe('new paragraphs, one string each'),
        },
        (args) => run('insert_blocks', args),
      ),
      // ---- relationships ----
      tool(
        'link_chapter_to_storyline',
        'Add a chapter as a member of a storyline. Chapters only — drifts are free-floating and cannot belong to a storyline.',
        {
          chapter: z.string().describe('Chapter NAME (must be a chapter, not a drift)'),
          storyline: z.string().describe('Storyline NAME'),
        },
        (args) => run('link_chapter_to_storyline', args),
      ),
      tool(
        'unlink_chapter_from_storyline',
        'Remove a chapter from a storyline.',
        {
          chapter: z.string().describe('Chapter NAME (must be a chapter, not a drift)'),
          storyline: z.string().describe('Storyline NAME'),
        },
        (args) => run('unlink_chapter_from_storyline', args),
      ),
      tool(
        'set_primary_storyline',
        "Make a storyline the chapter's primary storyline (adds membership if needed). Chapters only.",
        {
          chapter: z.string().describe('Chapter NAME (must be a chapter, not a drift)'),
          storyline: z.string().describe('Storyline NAME'),
        },
        (args) => run('set_primary_storyline', args),
      ),
      tool(
        'add_relation',
        'Create a curated cross-entity relation (story-graph edge), e.g. ally-of / belongs-to / located-in. The endpoints are entity NAMES. fromKind is one of node/element/patch/category/storyline/comment/library_item; toKind must be structural (node/element/patch/category/storyline). Reuse an existing "kind" label (see get_entity_relations) for consistency.',
        {
          fromKind: z.string(),
          from: z.string().describe('Source entity NAME'),
          toKind: z.string(),
          to: z.string().describe('Target entity NAME'),
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
          storyline: z.string(),
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
          category: z.string(),
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
      // ---- agent memory (author-level standing guidance the agent persists) ----
      tool(
        'remember',
        "Persist a STANDING piece of author-level guidance so it steers future turns (and the Shadow review engine). Use for: a personal writing PREFERENCE the author states ('对话尽量短句'), a VETO ('写死配角 X 的提案已否, 别再提'), or a DIRECTIVE about how to treat content ('梦境章节不用考虑物理合理性'). NOT for story-world facts (use update_element / facts / patches), NOT for book-level governing KV like 文风/POV/字数 (use update_project_facts), and NOT for an anchored 'THIS passage is intentional' note (use create_comment). The author is asked to confirm before it is saved. Returns { memoryId }.",
        {
          kind: z
            .string()
            .describe("'preference' (personal style/working pref) | 'veto' (a rejected proposal) | 'directive' (standing instruction on how to treat content)"),
          body: z.string().describe('The memory text — one self-contained sentence.'),
          target: z
            .string()
            .optional()
            .describe('Optional entity NAME this memory is about (e.g. the element a veto concerns)'),
          targetKind: z
            .string()
            .optional()
            .describe('Kind of `target`: node | element | storyline | category'),
          supersedes: z
            .string()
            .optional()
            .describe('memoryId of an existing memory this one replaces (it is retired) — use to EVOLVE a memory instead of duplicating it'),
        },
        (args) => run('remember', args),
      ),
      tool(
        'list_memory',
        'List the saved author-level memories (preferences / vetoes / directives) — both active and pending. Check this before remember to avoid duplicates or to find the memoryId to supersede/forget. Returns each as { memoryId, kind, status, body, target }.',
        {},
        () => run('list_memory', {}),
      ),
      tool(
        'forget',
        'Retire a saved memory by its memoryId (from list_memory) — e.g. a preference the author reversed. The author is asked to confirm. Soft-delete: kept for provenance but no longer steers anything.',
        { memoryId: z.string().describe('The memoryId from list_memory') },
        (args) => run('forget', args),
      ),
      tool(
        'create_node',
        "Create a new chapter or drift node. kind is 'chapter' (sits on the reading order, optionally linked to a storyline) or 'drift' (free-floating note).",
        {
          kind: z.string().describe("'chapter' or 'drift'"),
          title: z.string().optional(),
          storyline: z.string().optional().describe('For chapters: link to this storyline (NAME)'),
        },
        (args) => run('create_node', args),
      ),
      // ---- summary (reverse-generate: read the content yourself, then write) ----
      tool(
        'set_summary',
        "Write a summary onto an entity. To (re)generate a summary, read the content first (read_node / read_element) then call this. targetKind is node (chapter/drift) / element / storyline.",
        {
          targetKind: z.string().describe('node / element / storyline'),
          target: z.string().describe('Target entity NAME'),
          summary: z.string(),
        },
        (args) => run('set_summary', args),
      ),
      // ---- element patches (a character/place/item's per-chapter state change) ----
      tool(
        'create_element_patch',
        "Record a state-change patch for an element (how it changes at a point in the story). body is the patch prose; optionally anchor it to the chapter where the change happens via sourceChapter (NAME).",
        {
          element: z.string().describe('Element NAME'),
          title: z.string().optional(),
          body: z.string().optional().describe('The patch text'),
          sourceChapter: z
            .string()
            .optional()
            .describe('Chapter NAME where this change occurs'),
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
        "Create a comment, TODO, or Shadow exception. kind='note' is an editor annotation, kind='todo' shows in the right-sidebar TODO list, kind='exception' marks a block-anchored note as an author-sanctioned exception the Shadow review engine reads — use it to tell Shadow a flagged-looking passage is INTENTIONAL (anchor it via targetKind='node' + target + targetBlockId). Attach it to an entity via targetKind + target (the entity NAME). Add targetBlockId to anchor to a specific prose block, or omit it to attach to the whole chapter/element — an entity-level note shows in a stack at the bottom of that entity's editor. Omit all targets for a floating project-level TODO.",
        {
          body: z.string().describe('The comment / TODO text'),
          kind: z.string().optional().describe("'note' (default), 'todo', or 'exception'"),
          targetKind: z.string().optional().describe('node (chapter/drift) / element / storyline / …'),
          target: z.string().optional().describe('Entity NAME (matched to targetKind)'),
          targetBlockId: z.string().optional().describe('Prose block uuid to anchor to (optional)'),
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
        "Change a comment's kind. kind is 'todo', 'note', or 'exception' (mark a manual block note as an author-sanctioned Shadow exception — Shadow then treats that passage as intentional).",
        { commentId: z.string(), kind: z.string() },
        (args) => run('set_comment_kind', args),
      ),
      // ---- destructive (asks the user to confirm in the app) ----
      tool(
        'delete_element',
        'Delete an element. The app will ask the user to confirm before deleting; returns {declined:true} if they refuse.',
        { element: z.string() },
        (args) => run('delete_element', args),
      ),
    ],
  });
}
