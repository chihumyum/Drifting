/**
 * Main-process Claude Agent integration.
 *
 * Hosts the Claude Agent SDK `query()` loop (the SDK spawns the native
 * `claude` binary — must run in main, not the sandboxed renderer) and exposes
 * it to the renderer over IPC:
 *   - OAuth connect / status / logout
 *   - run a prompt, streaming normalized events back via `agent:event`
 *   - abort the running turn
 *
 * P0 scope: chat only (no tools). Entity tools arrive in P1+.
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

/** Normalized, structured-clonable event streamed to the renderer. */
export type AgentEvent =
  | { type: 'system'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'result'; ok: boolean; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type AgentMode = 'byok' | 'hosted';

export interface AgentStartInput {
  prompt: string;
  projectId?: string;
  /** Which credentials to use. Defaults to BYOK (the user's Claude OAuth). */
  mode?: AgentMode;
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

function normalize(msg: SDKMessage): AgentEvent | null {
  switch (msg.type) {
    case 'system':
      // init / compact-boundary / etc. — surface a light breadcrumb only.
      return { type: 'system', text: (msg as { subtype?: string }).subtype ?? 'system' };
    case 'assistant': {
      const text = extractAssistantText(msg);
      return text ? { type: 'assistant', text } : null;
    }
    case 'result': {
      const r = msg as Extract<SDKMessage, { type: 'result' }>;
      if (r.subtype === 'success') {
        return { type: 'result', ok: true, text: r.result };
      }
      return { type: 'result', ok: false, text: `Stopped: ${r.subtype} (turns=${r.num_turns})` };
    }
    default:
      return null; // partial/stream/status/etc. ignored in P0
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
        setStoredTokens(tokens);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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

      const driftingServer = await createDriftingMcpServer(getWindow);
      const abortController = new AbortController();
      activeAbort = abortController;

      const options: Options = {
        abortController,
        systemPrompt:
          'You are a writing assistant embedded in the Drifting creative-writing app. ' +
          'Inspect the project with: list_project_structure (call this FIRST to discover ids), ' +
          'read_chapter, read_element, search_project. ' +
          'You can also edit: update_element, create_element, rename_chapter, set_node_summary, ' +
          'edit_block (replace one prose block by its blockId from read_chapter), append_paragraph. ' +
          'Manage relationships: link_chapter_to_storyline, unlink_chapter_from_storyline, ' +
          'set_primary_storyline, add_relation (curated story-graph edge), and delete_element ' +
          '(the user is asked to confirm). ' +
          'Always read before you edit, and confirm ids. Make the smallest change that satisfies ' +
          'the request. Be concise.',
        settingSources: [], // don't inherit the user's ~/.claude project settings / CLAUDE.md
        tools: [], // no built-in tools — entities are reached only via the drifting MCP tools
        mcpServers: { drifting: driftingServer },
        permissionMode: 'bypassPermissions',
        includePartialMessages: false,
        env: auth.env,
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        stderr: (data: string) => console.error('[claude stderr]', data),
      };

      try {
        const { query } = await import(/* @vite-ignore */ '@anthropic-ai/claude-agent-sdk');
        const q = query({ prompt: input.prompt, options });
        activeQuery = q;
        for await (const msg of q) {
          if (activeQuery !== q) break; // superseded/aborted
          const event = normalize(msg);
          if (event) emit(event);
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
