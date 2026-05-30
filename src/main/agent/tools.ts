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
        'Case-insensitive search across chapter/drift titles, element names/summaries/aliases, and storyline names. Returns matching {kind,id,label}.',
        { query: z.string().describe('Text to search for') },
        (args) => run('search_project', args),
      ),
      // ---- writes ----
      tool(
        'update_element',
        'Update an element\'s fields. Only provided fields change.',
        {
          elementId: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          groupName: z.string().optional(),
        },
        (args) => run('update_element', args),
      ),
      tool(
        'create_element',
        'Create a new element under a category. categoryId is required (get it from list_project_structure).',
        {
          categoryId: z.string(),
          name: z.string().optional(),
          summary: z.string().optional(),
          aliases: z.array(z.string()).optional(),
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
    ],
  });
}
