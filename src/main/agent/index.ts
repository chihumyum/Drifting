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
import { randomUUID } from 'node:crypto';
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
  buildByokApiKeyEnv,
  buildHostedEnv,
  getApiBaseUrl,
  getDriftingSessionToken,
  readAgentApiKey,
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
  /** A complete extended-thinking block (fallback when it wasn't streamed). */
  | { type: 'thinking'; text: string }
  /** The agent invoked a tool (name already stripped of the mcp__drifting__ prefix). */
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  /** The agent updated its working plan (built-in TodoWrite tool). */
  | { type: 'todos'; items: AgentTodoItem[] }
  /** A tool returned its result, keyed back to the tool_use by id. */
  | { type: 'tool_result'; id: string; ok: boolean; text: string }
  | { type: 'result'; ok: boolean; text: string }
  /** Token usage + cost for the just-finished turn (from the SDK result message). */
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      turns: number;
    }
  /** The SDK session id for this turn — the renderer stores it to resume later. */
  | { type: 'session'; id: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * IPC envelope: every emitted event is tagged with the turn that produced it, so
 * the renderer can route a background turn's stream to the conversation that owns
 * it — even after the user has navigated to a different conversation or project.
 */
export interface AgentEventEnvelope {
  turnId: string;
  event: AgentEvent;
}

/**
 * Credential method for an Agent turn:
 *  - 'oauth':  the user's Claude account (OAuth token) — direct, unmetered.
 *  - 'apikey': a plain Anthropic API key (from the keychain) — pay-as-you-go.
 *  - 'hosted': route through Drifting's metering proxy (subscription).
 */
export type AgentMode = 'oauth' | 'apikey' | 'hosted';
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
  /** Which credentials to use. Defaults to 'oauth' (the user's Claude account). */
  mode?: AgentMode;
  /** Start a fresh conversation (ignore `resume`). */
  newConversation?: boolean;
  /** SDK session id to resume (continuity within a conversation). */
  resume?: string;
  /**
   * Renderer-generated id for this turn, echoed on every emitted event so the
   * renderer can route a background turn's stream to its conversation even after
   * the user navigates away. Generated here if omitted.
   */
  turnId?: string;
  /** Model alias or full id; 'default'/undefined lets the SDK pick. */
  model?: AgentModelChoice;
  /** Reasoning effort (SDK default is 'high'). */
  effort?: AgentEffortChoice;
  /** Extended-thinking mode. */
  thinking?: AgentThinkingChoice;
  /**
   * The manuscript's writing-language name (e.g. "Simplified Chinese (简体中文)").
   * Injected into the system prompt so the agent writes prose/replies in the
   * project's language rather than its own default.
   */
  writingLanguage?: string;
  /**
   * The project's key/value metadata (writing style/文风, POV/写作人称, target
   * chapter length, goals, reference works, …). Injected as governing prose
   * constraints. Empty/omitted → no style steer (the model's default voice).
   */
  projectFacts?: { key: string; value: string }[];
}

/**
 * Build the per-turn system-prompt suffix from the project's writing language +
 * KV metadata. Empty when neither is set, so a project with no preferences gets
 * no extra steer (the model's own default voice). Data-driven by design — there
 * is intentionally NO hardcoded tone default.
 */
function buildAgentMeta(input: AgentStartInput): string {
  const parts: string[] = [];
  if (input.writingLanguage) {
    parts.push(`Write all prose and replies in ${input.writingLanguage}.`);
  }
  const facts = (input.projectFacts ?? []).filter((f) => f.key || f.value);
  if (facts.length) {
    const lines = facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');
    parts.push(
      'Project metadata set by the author — e.g. writing style (文风), POV / person ' +
        '(写作人称), target chapter length, goals, reference works. Treat these as governing ' +
        'constraints when writing or editing prose: match the stated style and voice, write in the ' +
        'specified person/POV, and aim chapters at any target word count. Storyline-specific ' +
        'preferences, when present, live in that storyline’s facts (get_storyline).\n' + lines,
    );
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
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
  if (mode === 'apikey') {
    const key = readAgentApiKey();
    if (!key) {
      return { error: '尚未填写 Anthropic API Key。请在设置中填入，或切换到其它方式。' };
    }
    return { env: buildByokApiKeyEnv(key) };
  }
  const token = await getValidAccessToken();
  if (!token) {
    return { error: '尚未连接 Claude 账号（OAuth）。请先连接，或切换到其它方式。' };
  }
  return { env: buildByokEnv(token) };
}

let activeQuery: Query | null = null;
let activeAbort: AbortController | null = null;
// Session continuity is owned by the renderer now: it stores each conversation's
// SDK session id (reported via the 'session' event) and passes it back as
// `resume` on the next turn. Main holds no cross-turn session state.

const MCP_PREFIX = 'mcp__drifting__';

/** Drop the MCP server prefix so the UI shows e.g. "read_node". */
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

/** Concatenate any plaintext extended-thinking blocks on a complete assistant
 *  message (redacted/encrypted thinking has no text and is skipped). */
function extractThinkingText(msg: Extract<SDKMessage, { type: 'assistant' }>): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'thinking') {
      const t = (block as { thinking?: unknown }).thinking;
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
function toEvents(msg: SDKMessage, state: { sawDelta: boolean; sawThinking: boolean }): AgentEvent[] {
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
          state.sawThinking = true;
          return [{ type: 'thinking_delta', text: d.thinking }];
        }
      }
      return [];
    }
    case 'assistant': {
      const out: AgentEvent[] = [];
      // If extended thinking wasn't streamed token-by-token (adaptive thinking on
      // newer models returns it on the complete message instead of as
      // thinking_delta events), surface it here so the 思考 block still renders.
      if (!state.sawThinking) {
        const thinking = extractThinkingText(msg as Extract<SDKMessage, { type: 'assistant' }>);
        if (thinking) out.push({ type: 'thinking', text: thinking });
      }
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
      state.sawThinking = false;
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
      // The result message (success OR error) carries cumulative usage for the
      // turn — surface it so the panel can track tokens/cost per turn + session.
      const u = r.usage;
      const usageEvent: AgentEvent = {
        type: 'usage',
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
        costUsd: r.total_cost_usd ?? 0,
        turns: r.num_turns ?? 0,
      };
      if (r.subtype === 'success') {
        return [{ type: 'result', ok: true, text: r.result }, usageEvent];
      }
      return [
        { type: 'result', ok: false, text: `Stopped: ${r.subtype} (turns=${r.num_turns})` },
        usageEvent,
      ];
    }
    default:
      return []; // partial/status/etc. ignored
  }
}

export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  registerToolResultListener();

  const emit = (turnId: string, event: AgentEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('agent:event', { turnId, event } satisfies AgentEventEnvelope);
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
    async (): Promise<{
      byokConnected: boolean;
      apiKeyConnected: boolean;
      hostedAvailable: boolean;
    }> => {
      const hostedToken = await getDriftingSessionToken();
      return {
        byokConnected: isAuthenticated(),
        apiKeyConnected: readAgentApiKey() !== null,
        hostedAvailable: !!hostedToken,
      };
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
      const mode: AgentMode = input.mode ?? 'oauth';
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

      // Tag every event for this turn so the renderer routes the stream to the
      // owning conversation (background turns survive navigation).
      const turnId = input.turnId ?? randomUUID();

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
          'Orient first with get_project_brief, then list_nodes (storylines + chapters + drifts) ' +
          'and/or list_elements (categories + elements) to see the manuscript — both list BY NAME. ' +
          "A 'node' is a chapter OR a drift (free-floating note); they share one name space. " +
          'Gather context by TRAVERSING the graph instead of reading every node: ' +
          'where_does_entity_appear (all scenes mentioning a character/place/item), ' +
          'get_entity_relations (curated story-graph edges, both directions), ' +
          'get_storyline (a storyline + its chapters), get_node_context (a node overview — ' +
          'summary, rolling summaries, referenced elements, storylines — WITHOUT the full prose), ' +
          'get_element_patches (how an element evolves), list_comments (editorial notes). ' +
          'Search with search_project (titles/names) or search_prose (inside the prose, with snippets). ' +
          'Entity reference args are NAMES (project-unique) — never ids: pass the entity by name via ' +
          'the node / element / storyline / category arg (or, for kind+name tools, the name arg) — ' +
          'e.g. read_node({node:"第三章"}), update_element({element:"林夏"}). Tool RESULTS are by name ' +
          'too. The only opaque handles are for things with no name — blockId (prose blocks), ' +
          'commentId, relationId, patchId — and you only ever copy those back from the read tool ' +
          'that returned them. resolve_entity is a rarely-needed fallback for an ambiguous name. ' +
          'Read full detail only when needed: read_node, read_element. ' +
          'You can also edit: update_element (incl. category to recategorize, facts to set ' +
          'structured kv), create_element, rename_node, set_node_summary, edit_block (replace ' +
          'one prose block by its number from read_node; use edit_blocks for several blocks ' +
          'in one node — atomic), append_paragraph. Prose edits apply to the node live — no ' +
          'need to close the editor. To RESTRUCTURE prose (delete a block, replace a range of ' +
          'blocks with a different number of blocks, or insert blocks mid-node) use ' +
          'remove_blocks / replace_block_range / insert_blocks; these address blocks by their ' +
          'stable uuid blockId, NOT the read_node number (numbers shift after a structural ' +
          'edit), so call lookup_block first to resolve a number or text snippet to its blockId. ' +
          'Build structure: create_storyline / update_storyline (incl. facts), create_category / ' +
          "update_category (element template facts), create_node (a 'chapter' or 'drift'). " +
          'Record book-level writing preferences (文风 / 写作人称 / 章节目标字数 / 目标 / 对标作品) ' +
          'with update_project_facts so they persist and steer future writing. ' +
          'Summaries: to (re)generate a summary, read the content then call set_summary ' +
          '(node/element/storyline). Track element evolution with create_element_patch / ' +
          'update_element_patch / delete_element_patch. Notes & tasks: create_comment ' +
          "(kind 'note' or 'todo'), set_comment_status (resolve/reopen), set_comment_kind " +
          '(todo↔note), delete_comment. For a block-anchored TODO (list_comments returns its ' +
          'target + targetBlockId), call read_block(node=target, blockId=targetBlockId) to get the ' +
          'live text, then act on it and set_comment_status to resolve. ' +
          'Build relationships between entities: link_chapter_to_storyline, ' +
          'unlink_chapter_from_storyline, set_primary_storyline (chapters only — drifts cannot ' +
          'belong to a storyline), add_relation (curated story-graph edge — reuse existing kind ' +
          'labels), remove_relation / update_relation_kind (by the relationId from ' +
          'get_entity_relations), and delete_element (the user is asked to confirm). ' +
          'To relate things that do not exist yet, create the storyline/category/element first, ' +
          'then link them. ' +
          'Prefer the cheap overview/traversal tools before pulling full prose. ' +
          'For real-world facts the manuscript cannot supply (history, geography, science, ' +
          '风物 考据), use WebSearch to verify and WebFetch to read a source — then state what ' +
          'you found and where. Do not invent facts you could have looked up. ' +
          'For multi-step tasks, use TodoWrite to lay out a plan and tick items off as you go. ' +
          'Always read before you edit. Make the smallest change that satisfies ' +
          'the request. Be concise.' +
          buildAgentMeta(input),
        settingSources: [], // don't inherit the user's ~/.claude project settings / CLAUDE.md
        // Built-in tools we allow: TodoWrite (internal planning/progress) and
        // WebSearch/WebFetch (real-world fact-checking — history, geography,
        // 风物 考据). Filesystem tools (Read/Edit/Bash/…) stay OFF since the
        // manuscript is reached solely via the drifting MCP tools. WebSearch is
        // a hosted Anthropic tool and is billed against whatever auth path runs.
        tools: ['TodoWrite', 'WebSearch', 'WebFetch'],
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
        const streamState = { sawDelta: false, sawThinking: false };
        let reportedSession: string | null = null;
        for await (const msg of q) {
          if (activeQuery !== q) break; // superseded/aborted
          const sid = (msg as { session_id?: string }).session_id;
          if (typeof sid === 'string' && sid && sid !== reportedSession) {
            reportedSession = sid;
            emit(turnId, { type: 'session', id: sid });
          }
          for (const event of toEvents(msg, streamState)) emit(turnId, event);
        }
        emit(turnId, { type: 'done' });
        return { ok: true };
      } catch (err) {
        // The turn was already in flight. Surface any failure as a tagged
        // 'error' event (the renderer routes it to the owning conversation) and
        // report ok:true — the renderer's !ok branch is reserved for pre-flight
        // failures (e.g. auth) that never emitted anything for this turn.
        if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          emit(turnId, { type: 'error', message });
        }
        emit(turnId, { type: 'done' });
        return { ok: true };
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
