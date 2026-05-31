/**
 * Agent chat store (module-level, in-memory).
 *
 * Holds the right-sidebar Agent conversation so it survives the panel
 * unmounting/remounting when the user switches sidebar tabs — the view is a
 * thin projection of this store. The single agent-event subscription also lives
 * here (set up once), so streaming keeps flowing and `done` still persists even
 * while the panel isn't mounted.
 *
 * Display transcript is persisted to SQLite (agent_conversation) on each turn's
 * `done`; the SDK's own session file is the source of truth for *resuming*
 * context, tracked here as sdkSessionId and passed back as `resume`.
 */
import { create } from 'zustand';
import { v7 as uuidv7 } from 'uuid';
import { useSettingsStore } from './settings-store';
import { useProjectStore } from './project-store';
import { useAgentActivityStore } from './agent-activity-store';
import { parseKv } from '../domain/kv';
import { resolveWritingLanguage } from '../lib/ai/output-language';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import type {
  AgentChatMessage as ChatMsg,
  AgentConversationSummary,
} from '../domain/agent-conversation';
import type { AgentEvent } from '../../main/agent';

const repo = createAgentConversationRepository();

// ---- transcript reducer (pure) --------------------------------------------

/** Mark any trailing still-streaming assistant/thinking message as finished. */
function finalizeStreaming(list: ChatMsg[]): ChatMsg[] {
  const last = list[list.length - 1];
  if (last && (last.kind === 'assistant' || last.kind === 'thinking') && last.streaming) {
    const copy = list.slice();
    copy[copy.length - 1] = { ...last, streaming: false };
    return copy;
  }
  return list;
}

/** Fold one streamed agent event into the chat transcript. */
export function applyEvent(list: ChatMsg[], ev: AgentEvent): ChatMsg[] {
  switch (ev.type) {
    case 'assistant_delta': {
      const last = list[list.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [...finalizeStreaming(list), { kind: 'assistant', text: ev.text, streaming: true }];
    }
    case 'thinking_delta': {
      const last = list[list.length - 1];
      if (last && last.kind === 'thinking' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [...finalizeStreaming(list), { kind: 'thinking', text: ev.text, streaming: true }];
    }
    case 'assistant':
      return [...finalizeStreaming(list), { kind: 'assistant', text: ev.text, streaming: false }];
    case 'thinking':
      // Complete (non-streamed) thinking block — appears all at once after the
      // model finishes, when thinking_delta events didn't fire.
      return [...finalizeStreaming(list), { kind: 'thinking', text: ev.text, streaming: false }];
    case 'tool_use':
      return [
        ...finalizeStreaming(list),
        { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' },
      ];
    case 'todos': {
      // The plan is replaced in place — keep a single todos block at its
      // original position and refresh its items as TodoWrite is re-called.
      const idx = list.findIndex((m) => m.kind === 'todos');
      if (idx === -1) return [...finalizeStreaming(list), { kind: 'todos', items: ev.items }];
      const copy = list.slice();
      copy[idx] = { kind: 'todos', items: ev.items };
      return copy;
    }
    case 'tool_result': {
      const idx = list.findIndex((m) => m.kind === 'tool' && m.id === ev.id);
      if (idx === -1) return list;
      const copy = list.slice();
      const t = copy[idx] as Extract<ChatMsg, { kind: 'tool' }>;
      copy[idx] = { ...t, status: ev.ok ? 'ok' : 'error', result: ev.text };
      return copy;
    }
    case 'result':
      // A successful result mirrors the last assistant text — only surface failures.
      return ev.ok
        ? finalizeStreaming(list)
        : [...finalizeStreaming(list), { kind: 'error', text: ev.text }];
    case 'usage':
      // Skip empty usage rows (e.g. a turn that produced no tokens).
      if (!ev.inputTokens && !ev.outputTokens && !ev.costUsd) return list;
      return [
        ...finalizeStreaming(list),
        {
          kind: 'usage',
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          cacheCreationTokens: ev.cacheCreationTokens,
          costUsd: ev.costUsd,
          turns: ev.turns,
        },
      ];
    case 'error':
      return [...finalizeStreaming(list), { kind: 'error', text: ev.message }];
    case 'system':
      return list; // suppress init / compact breadcrumbs
    case 'done':
      return finalizeStreaming(list);
    default:
      return list; // 'session' handled separately (stored on the store)
  }
}

/** First user line, condensed, as the conversation title. */
function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

// ---- store -----------------------------------------------------------------

interface AgentChatState {
  /** The project this conversation belongs to (null before first bind). */
  boundProjectId: string | null;
  messages: ChatMsg[];
  prompt: string;
  running: boolean;
  activeConvId: string | null;
  sdkSessionId: string | null;
  convList: AgentConversationSummary[];

  setPrompt: (p: string) => void;
  /** Mount/route hook: load this project's history; reset chat only if the
   *  project actually changed (so a remount with the same project keeps view). */
  bindProject: (projectId: string) => void;
  refreshList: () => void;
  send: () => Promise<void>;
  abort: () => void;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  boundProjectId: null,
  messages: [],
  prompt: '',
  running: false,
  activeConvId: null,
  sdkSessionId: null,
  convList: [],

  setPrompt: (p) => set({ prompt: p }),

  refreshList: () => {
    const pid = get().boundProjectId;
    if (!pid) return;
    void repo
      .listByProject(pid)
      .then((rows) => set({ convList: rows }))
      .catch(() => set({ convList: [] }));
  },

  bindProject: (projectId) => {
    ensureSubscription();
    if (get().boundProjectId === projectId) {
      // Same project (e.g. a remount) — keep the live transcript, just refresh.
      get().refreshList();
      return;
    }
    // Project changed — reset the live chat and load that project's history.
    useAgentActivityStore.getState().clearAll();
    set({
      boundProjectId: projectId,
      messages: [],
      activeConvId: null,
      sdkSessionId: null,
      prompt: '',
      running: false,
    });
    // Load history, then re-open the conversation the user last had active for
    // this project (persisted pointer + SQLite transcript), so a reload/restart
    // doesn't drop them into an empty "新对话".
    void (async () => {
      let rows: AgentConversationSummary[] = [];
      try {
        rows = await repo.listByProject(projectId);
      } catch {
        rows = [];
      }
      // The project may have changed again (or a conversation started) while the
      // async list was in flight — bail rather than clobber newer state.
      if (get().boundProjectId !== projectId) return;
      set({ convList: rows });
      const lastId = useSettingsStore.getState().lastAgentConvByProject[projectId];
      // Only restore a conversation that still exists (listByProject already
      // filters soft-deleted rows) and only if the user hasn't started one.
      if (lastId && !get().activeConvId && rows.some((r) => r.id === lastId)) {
        await get().loadConversation(lastId);
      }
    })();
  },

  send: async () => {
    ensureSubscription();
    const api = window.electronAPI?.agent;
    const s = get();
    if (!api || !s.prompt.trim() || s.running) return;
    const text = s.prompt.trim();
    const now = new Date().toISOString();
    const settings = useSettingsStore.getState();
    const mode = settings.agentMode;

    // Lazily create the conversation row on the first message so it shows up in
    // history immediately; the transcript is overwritten on `done`.
    let convId = s.activeConvId;
    if (!convId && s.boundProjectId) {
      convId = uuidv7();
      try {
        await repo.create({
          id: convId,
          projectId: s.boundProjectId,
          title: deriveTitle(text),
          mode,
          messages: [{ kind: 'user', text }],
          sdkSessionId: null,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        /* persistence is best-effort — chat still works in-memory */
      }
      set({ activeConvId: convId });
      get().refreshList();
    }
    // Remember this as the project's last-active conversation so it re-opens on
    // next launch.
    if (s.boundProjectId && convId) {
      useSettingsStore.getState().setLastAgentConv(s.boundProjectId, convId);
    }

    // Project writing preferences (KV facts) + writing language, injected into
    // the agent's system prompt so it honors the author's style/POV/length and
    // writes in the manuscript's language. Empty facts → no style steer.
    const project = useProjectStore.getState().currentProject;
    const projectFacts =
      project && project.id === s.boundProjectId ? parseKv(project.kvJson) : [];
    const writingLanguage = resolveWritingLanguage(s.boundProjectId);

    set((st) => ({ messages: [...st.messages, { kind: 'user', text }], prompt: '', running: true }));
    const r = await api.start({
      prompt: text,
      mode,
      model: settings.agentModel,
      effort: settings.agentEffort,
      thinking: settings.agentThinking,
      resume: s.sdkSessionId ?? undefined,
      writingLanguage,
      projectFacts,
    });
    if (!r.ok) {
      set((st) => ({ messages: [...st.messages, { kind: 'error', text: r.error }], running: false }));
    }
  },

  abort: () => {
    void window.electronAPI?.agent?.abort();
  },

  newConversation: () => {
    void window.electronAPI?.agent?.resetSession();
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
    useAgentActivityStore.getState().clearAll();
    set({ messages: [], activeConvId: null, sdkSessionId: null, prompt: '', running: false });
  },

  loadConversation: async (id) => {
    const conv = await repo.get(id);
    if (!conv) return;
    set({ messages: conv.messages, activeConvId: conv.id, sdkSessionId: conv.sdkSessionId });
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().setLastAgentConv(pid, conv.id);
  },

  deleteConversation: async (id) => {
    try {
      await repo.softDelete(id, new Date().toISOString());
    } catch {
      /* ignore */
    }
    if (get().activeConvId === id) {
      const pid = get().boundProjectId;
      if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
      set({ messages: [], activeConvId: null, sdkSessionId: null });
    }
    get().refreshList();
  },

  renameConversation: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      // Renaming isn't conversation activity. Leave updatedAt untouched so it
      // cannot race with transcript persistence and disturb history ordering.
      await repo.update(id, { title: trimmed });
    } catch {
      /* best-effort */
    }
    get().refreshList();
  },
}));

// ---- persistence + single global event subscription ------------------------

async function persistActive(): Promise<void> {
  const { activeConvId, messages, sdkSessionId } = useAgentChatStore.getState();
  if (!activeConvId) return;
  try {
    await repo.update(activeConvId, {
      messages,
      sdkSessionId,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort */
  }
  useAgentChatStore.getState().refreshList();
}

function handleEvent(ev: AgentEvent): void {
  if (ev.type === 'session') {
    useAgentChatStore.setState({ sdkSessionId: ev.id });
    return;
  }
  useAgentChatStore.setState((s) => ({ messages: applyEvent(s.messages, ev) }));
  // Mirror tool activity to the perception store (left-panel pulses + dots) —
  // but only while a turn is actively running, so late events from a turn the
  // user switched projects away from don't seed marks for foreign entities.
  const activity = useAgentActivityStore.getState();
  if (useAgentChatStore.getState().running) {
    if (ev.type === 'tool_use') activity.onToolUse(ev.id, ev.name, ev.input);
    else if (ev.type === 'tool_result') activity.onToolResult(ev.id, ev.ok, ev.text);
  }
  if (ev.type === 'done') {
    activity.onTurnEnd();
    useAgentChatStore.setState({ running: false });
    // `set` is synchronous, so getState() inside persist sees the finalized
    // transcript (the done event's applyEvent already applied).
    void persistActive();
  }
}

let subscribed = false;
/** Subscribe to agent events once for the app's lifetime (never torn down, so
 *  streaming survives the panel unmounting). Idempotent. */
function ensureSubscription(): void {
  if (subscribed) return;
  const api = window.electronAPI?.agent;
  if (!api) return;
  subscribed = true;
  api.onEvent(handleEvent);
}
