/**
 * Main-process Claude Agent integration.
 *
 * Hosts the Claude Agent SDK `query()` loop (the SDK spawns the native
 * `claude` binary — must run in main, not the sandboxed renderer) and exposes
 * it to the renderer over IPC:
 *   - OAuth connect / status / logout
 *   - run a prompt, streaming normalized events back via `agent:event`
 *     (token deltas, tool_use, tool_result, result)
 *   - abort the running turn
 */
import { ipcMain, shell, type BrowserWindow } from 'electron';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { prepareClaudeOAuth, exchangeClaudeCode } from './oauth';
import {
  setStoredTokens,
  clearStoredTokens,
  isAuthenticated,
  getValidAccessToken,
} from './token-store';
import {
  resolveClaudeBinary,
  ensureClaudeConfig,
  buildByokEnv,
  buildHostedEnv,
  getApiBaseUrl,
  getDriftingSessionToken,
} from './runtime';
import { registerToolResultListener } from './bridge';
import { createDriftingMcpServer } from './tools';

/** One item in the agent's working plan (built-in TodoWrite tool). */
export interface AgentTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Normalized, structured-clonable event streamed to the renderer. */
export type AgentEvent =
  | { type: 'system'; text: string }
  /** A complete assistant text block (fallback when streaming didn't fire). */
  | { type: 'assistant'; text: string }
  /** A streamed token chunk of the current assistant text block. */
  | { type: 'assistant_delta'; text: string }
  /** A streamed token chunk of the model's extended-thinking block. */
  | { type: 'thinking_delta'; text: string }
  /** The agent invoked a tool (name already stripped of the mcp__drifting__ prefix). */
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  /** The agent updated its working plan (built-in TodoWrite tool). */
  | { type: 'todos'; items: AgentTodoItem[] }
  /** A tool returned its result, keyed back to the tool_use by id. */
  | { type: 'tool_result'; id: string; ok: boolean; text: string }
  | { type: 'result'; ok: boolean; text: string }
  /** The SDK session id for this turn — the renderer stores it to resume later. */
  | { type: 'session'; id: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type AgentMode = 'byok' | 'hosted';
/**
 * Generation params surfaced from settings; mirror the SDK Options.
 *  - model: free string per the SDK — tier alias ('opus'/'sonnet'/'haiku'),
 *    pinned id ('claude-opus-4-8', …), or 'default' (omit → CLI default).
 *  - effort: full EffortLevel range (xhigh/max are Opus-only; SDK handles it).
 */
export type AgentModelChoice = string;
export type AgentEffortChoice = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentThinkingChoice = 'adaptive' | 'off';

export interface AgentStartInput {
  prompt: string;
  projectId?: string;
  /** Which credentials to use. Defaults to BYOK (the user's Claude OAuth). */
  mode?: AgentMode;
  /** Start a fresh conversation (ignore `resume`). */
  newConversation?: boolean;
  /** SDK session id to resume (continuity within a conversation). */
  resume?: string;
  /** Model alias or full id; 'default'/undefined lets the SDK pick. */
  model?: AgentModelChoice;
  /** Reasoning effort (SDK default is 'high'). */
  effort?: AgentEffortChoice;
  /** Extended-thinking mode. */
  thinking?: AgentThinkingChoice;
}

/** Resolve the subprocess env for the chosen mode, or an error to surface. */
async function resolveAuthEnv(
  mode: AgentMode,
): Promise<{ env: Record<string, string> } | { error: string }> {
  if (mode === 'hosted') {
    const token = await getDriftingSessionToken();
    if (!token) {
      return { error: '未登录 Drifting，无法使用托管订阅。请先登录账号。' };
    }
    return { env: buildHostedEnv(token, getApiBaseUrl()) };
  }
  const token = await getValidAccessToken();
  if (!token) {
    return { error: '尚未连接 Claude（BYOK）。请先连接，或切换到托管订阅。' };
  }
  return { env: buildByokEnv(token) };
}

let activeQuery: Query | null = null;
let activeAbort: AbortController | null = null;
// Session continuity is owned by the renderer now: it stores each conversation's
// SDK session id (reported via the 'session' event) and passes it back as
// `resume` on the next turn. Main holds no cross-turn session state.

const MCP_PREFIX = 'mcp__drifting__';

/** Drop the MCP server prefix so the UI shows e.g. "read_chapter". */
function stripToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Parse the built-in TodoWrite tool input into a plain todo list. */
function parseTodos(input: unknown): AgentTodoItem[] {
  const todos = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.map((t) => {
    const o = (t ?? {}) as { content?: unknown; status?: unknown; activeForm?: unknown };
    const status: AgentTodoItem['status'] =
      o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    return {
      content: typeof o.content === 'string' ? o.content : '',
      status,
      ...(typeof o.activeForm === 'string' ? { activeForm: o.activeForm } : {}),
    };
  });
}

function extractAssistantText(msg: Extract<SDKMessage, { type: 'assistant' }>): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') text += t;
    }
  }
  return text;
}

/** Flatten a tool_result block's content (string | array of text parts) to text. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let text = '';
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string') text += t;
      }
    }
    return text;
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Translate one SDK message into zero or more normalized, structured-clonable
 * events. `state.sawDelta` tracks whether the current assistant message's text
 * was already streamed token-by-token (via stream_event), so the complete
 * assistant message doesn't re-emit it — it only contributes tool_use blocks.
 */
function toEvents(msg: SDKMessage, state: { sawDelta: boolean }): AgentEvent[] {
  switch (msg.type) {
    case 'system':
      // init / compact-boundary / etc. — currently suppressed in the UI.
      return [{ type: 'system', text: (msg as { subtype?: string }).subtype ?? 'system' }];
    case 'stream_event': {
      const ev = (
        msg as {
          event?: {
            type?: string;
            delta?: { type?: string; text?: unknown; thinking?: unknown };
          };
        }
      ).event;
      if (ev?.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          state.sawDelta = true;
          return [{ type: 'assistant_delta', text: d.text }];
        }
        if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
          return [{ type: 'thinking_delta', text: d.thinking }];
        }
      }
      return [];
    }
    case 'assistant': {
      const out: AgentEvent[] = [];
      // If streaming already delivered the text, don't duplicate it.
      if (!state.sawDelta) {
        const text = extractAssistantText(msg as Extract<SDKMessage, { type: 'assistant' }>);
        if (text) out.push({ type: 'assistant', text });
      }
      const blocks = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') {
            const tu = b as { id?: string; name?: string; input?: unknown };
            // The built-in TodoWrite tool drives the plan UI, not a tool row.
            if (tu.name === 'TodoWrite') {
              out.push({ type: 'todos', items: parseTodos(tu.input) });
              continue;
            }
            out.push({
              type: 'tool_use',
              id: String(tu.id ?? ''),
              name: stripToolName(String(tu.name ?? '')),
              input: tu.input,
            });
          }
        }
      }
      state.sawDelta = false;
      return out;
    }
    case 'user': {
      // Tool results come back as user messages with tool_result content blocks.
      const out: AgentEvent[] = [];
      const blocks = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result') {
            const tr = b as { tool_use_id?: string; is_error?: boolean; content?: unknown };
            out.push({
              type: 'tool_result',
              id: String(tr.tool_use_id ?? ''),
              ok: !tr.is_error,
              text: extractToolResultText(tr.content),
            });
          }
        }
      }
      return out;
    }
    case 'result': {
      const r = msg as Extract<SDKMessage, { type: 'result' }>;
      if (r.subtype === 'success') {
        return [{ type: 'result', ok: true, text: r.result }];
      }
      return [{ type: 'result', ok: false, text: `Stopped: ${r.subtype} (turns=${r.num_turns})` }];
    }
    default:
      return []; // partial/status/etc. ignored
  }
}

export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  registerToolResultListener();

  const emit = (event: AgentEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('agent:event', event);
    }
  };

  // ---- Auth ----------------------------------------------------------------

  ipcMain.handle('agent:auth-prepare', async (): Promise<{ url: string }> => {
    const url = prepareClaudeOAuth();
    // Open in the user's browser so the OAuth state cookie lives there.
    await shell.openExternal(url);
    return { url };
  });

  ipcMain.handle(
    'agent:auth-submit-code',
    async (_e, code: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const tokens = await exchangeClaudeCode(code);
        const saved = setStoredTokens(tokens);
        if (!saved || !isAuthenticated()) {
          return {
            ok: false,
            error: '已获取授权，但凭据未能写入系统钥匙串（请检查 keychain 访问权限）。',
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Session continuity now lives in the renderer (it just stops passing
  // `resume`). Kept as a no-op so the preload API + older callers don't break.
  ipcMain.handle('agent:reset-session', (): { ok: true } => ({ ok: true }));

  ipcMain.handle(
    'agent:auth-status',
    async (): Promise<{ byokConnected: boolean; hostedAvailable: boolean }> => {
      const hostedToken = await getDriftingSessionToken();
      return { byokConnected: isAuthenticated(), hostedAvailable: !!hostedToken };
    },
  );

  ipcMain.handle('agent:auth-logout', (): { ok: true } => {
    clearStoredTokens();
    return { ok: true };
  });

  // ---- Run -----------------------------------------------------------------

  ipcMain.handle(
    'agent:start',
    async (_e, input: AgentStartInput): Promise<{ ok: true } | { ok: false; error: string }> => {
      const mode: AgentMode = input.mode ?? 'byok';
      const auth = await resolveAuthEnv(mode);
      if ('error' in auth) {
        return { ok: false, error: auth.error };
      }

      // Only one turn at a time — interrupt any prior run.
      if (activeQuery) {
        try {
          await activeQuery.interrupt();
        } catch {
          /* already finished */
        }
        activeQuery = null;
      }

      ensureClaudeConfig();

      // Resume the conversation the renderer asked for (unless it's a fresh one).
      const resume = input.newConversation ? undefined : input.resume;

      const driftingServer = await createDriftingMcpServer(getWindow);
      const abortController = new AbortController();
      activeAbort = abortController;

      const options: Options = {
        abortController,
        // Continue the conversation the renderer is tracking.
        ...(resume ? { resume } : {}),
        systemPrompt:
          'You are a writing assistant embedded in the Drifting creative-writing app. ' +
          'Orient first with get_project_brief, then list_project_structure to discover ids. ' +
          'Gather context by TRAVERSING the graph instead of reading every chapter: ' +
          'where_does_entity_appear (all scenes mentioning a character/place/item), ' +
          'get_entity_relations (curated story-graph edges, both directions), ' +
          'get_storyline (a storyline + its chapters), get_chapter_context (a chapter overview — ' +
          'summary, rolling summaries, referenced elements, storylines — WITHOUT the full prose), ' +
          'get_element_patches (how an element evolves), list_comments (editorial notes). ' +
          'Search with search_project (titles/names) or search_prose (inside the prose, with snippets). ' +
          'Read full detail only when needed: read_chapter, read_element. ' +
          'You can also edit: update_element (incl. categoryId to recategorize, facts to set ' +
          'structured kv), create_element, rename_chapter, set_node_summary, edit_block (replace ' +
          'one prose block by its blockId from read_chapter), append_paragraph. ' +
          'Build structure: create_storyline / update_storyline, create_category, create_node ' +
          "(a 'chapter' or 'drift'). " +
          'Summaries: to (re)generate a summary, read the content then call set_summary ' +
          '(node/element/storyline). Track element evolution with create_element_patch / ' +
          'update_element_patch / delete_element_patch. Notes & tasks: create_comment ' +
          "(kind 'note' or 'todo'), set_comment_status (resolve/reopen), set_comment_kind " +
          '(todo↔note), delete_comment. ' +
          'Build relationships between entities: link_chapter_to_storyline, ' +
          'unlink_chapter_from_storyline, set_primary_storyline, add_relation (curated story-graph ' +
          'edge — reuse existing kind labels), remove_relation / update_relation_kind (by the ' +
          'relationId from get_entity_relations), and delete_element (the user is asked to confirm). ' +
          'To relate things that do not exist yet, create the storyline/category/element first, ' +
          'then link them. ' +
          'Prefer the cheap overview/traversal tools before pulling full prose. ' +
          'For multi-step tasks, use TodoWrite to lay out a plan and tick items off as you go. ' +
          'Always read before you edit, and confirm ids. Make the smallest change that satisfies ' +
          'the request. Be concise.',
        settingSources: [], // don't inherit the user's ~/.claude project settings / CLAUDE.md
        // Only the built-in TodoWrite (internal planning/progress — no side
        // effects); filesystem tools (Read/Edit/Bash/…) stay OFF since entities
        // are reached solely via the drifting MCP tools.
        tools: ['TodoWrite'],
        mcpServers: { drifting: driftingServer },
        permissionMode: 'bypassPermissions',
        // Stream token deltas so the panel can render assistant text live.
        includePartialMessages: true,
        // User-tunable generation params (Settings → General Agent). 'default'
        // model omits the field so the SDK/subscription default applies.
        ...(input.model && input.model !== 'default' ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        thinking: input.thinking === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
        env: auth.env,
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        stderr: (data: string) => console.error('[claude stderr]', data),
      };

      try {
        const { query } = await import(/* @vite-ignore */ '@anthropic-ai/claude-agent-sdk');
        const q = query({ prompt: input.prompt, options });
        activeQuery = q;
        const streamState = { sawDelta: false };
        let reportedSession: string | null = null;
        for await (const msg of q) {
          if (activeQuery !== q) break; // superseded/aborted
          const sid = (msg as { session_id?: string }).session_id;
          if (typeof sid === 'string' && sid && sid !== reportedSession) {
            reportedSession = sid;
            emit({ type: 'session', id: sid });
          }
          for (const event of toEvents(msg, streamState)) emit(event);
        }
        emit({ type: 'done' });
        return { ok: true };
      } catch (err) {
        if (abortController.signal.aborted) {
          // User-initiated stop — not an error.
          emit({ type: 'done' });
          return { ok: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message });
        emit({ type: 'done' });
        return { ok: false, error: message };
      } finally {
        activeQuery = null;
        if (activeAbort === abortController) activeAbort = null;
      }
    },
  );

  ipcMain.handle('agent:abort', async (): Promise<{ ok: true }> => {
    const q = activeQuery;
    const ac = activeAbort;
    activeQuery = null;
    activeAbort = null;
    if (ac) ac.abort();
    if (q) {
      try {
        await q.interrupt();
      } catch {
        /* already done */
      }
    }
    return { ok: true };
  });
}
