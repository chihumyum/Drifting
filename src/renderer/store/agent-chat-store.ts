/**
 * Agent chat store (module-level, in-memory).
 *
 * Holds the right-sidebar Agent conversations so they survive the panel
 * unmounting/remounting when the user switches sidebar tabs — the view is a thin
 * projection of this store. The single agent-event subscription also lives here
 * (set up once), so streaming keeps flowing and `done` still persists even while
 * the panel isn't mounted.
 *
 * Per-conversation live state lives in `runs` (keyed by convId), which decouples
 * "which conversation is displayed" (`activeConvId`) from "which conversation a
 * streamed event belongs to" (resolved from the event's turnId via `turnConv`).
 * That decoupling is what lets a turn keep running in the background: switching
 * conversation or project changes only the displayed `runs` entry; the in-flight
 * turn keeps folding into — and on `done` persists to — its OWN conversation.
 *
 * Display transcript is persisted to SQLite (agent_conversation) on each turn's
 * `done`; the SDK's own session file is the source of truth for *resuming*
 * context, tracked per run as sdkSessionId and passed back as `resume`.
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
import type { AgentEvent, AgentEventEnvelope } from '../../main/agent';

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

/** Stable empty transcript so selectors never return a fresh array (which would
 *  re-render on every state change). */
const EMPTY_MESSAGES: ChatMsg[] = [];

/**
 * Live state for one conversation opened (or running) this session. Keyed by
 * convId in `runs`, this is what decouples "which conversation is displayed"
 * from "which conversation a streamed event belongs to": a background turn keeps
 * folding into its own RunState even while the user views another conversation.
 */
interface RunState {
  /** Owning project — so a background turn doesn't pulse another project's cells. */
  projectId: string;
  messages: ChatMsg[];
  /** SDK session to resume context; null until the first turn reports one. */
  sdkSessionId: string | null;
}

interface AgentChatState {
  /** The project whose history is currently displayed (null before first bind). */
  boundProjectId: string | null;
  /** Which conversation is displayed (null = a fresh, unsaved chat). */
  activeConvId: string | null;
  /** convId → live transcript/session, for every conversation touched this run. */
  runs: Record<string, RunState>;
  prompt: string;
  convList: AgentConversationSummary[];
  /** The single in-flight turn (main runs one at a time); null when idle. */
  runningTurnId: string | null;
  /** The conversation that in-flight turn belongs to; null when idle. */
  runningConvId: string | null;

  setPrompt: (p: string) => void;
  /** Mount/route hook: switch to this project's history. Background runs and the
   *  in-flight turn are preserved across the switch. */
  bindProject: (projectId: string) => void;
  refreshList: () => void;
  send: () => Promise<void>;
  abort: () => void;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
}

/** The displayed conversation's transcript (stable empty ref when none). */
export const selectMessages = (s: AgentChatState): ChatMsg[] =>
  s.activeConvId ? s.runs[s.activeConvId]?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
/** Is the displayed conversation the one with the in-flight turn? */
export const selectRunning = (s: AgentChatState): boolean =>
  s.runningConvId !== null && s.runningConvId === s.activeConvId;
/** A turn is running, but in a DIFFERENT conversation than the one displayed. */
export const selectOtherRunning = (s: AgentChatState): boolean =>
  s.runningConvId !== null && s.runningConvId !== s.activeConvId;

// Maps an in-flight turn id → the conversation that owns it, so streamed events
// route to that conversation even after the user navigates elsewhere. A turn not
// in this map is foreign (e.g. left over from before a reload) and is ignored.
const turnConv = new Map<string, string>();

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  boundProjectId: null,
  activeConvId: null,
  runs: {},
  prompt: '',
  convList: [],
  runningTurnId: null,
  runningConvId: null,

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
    // Switching CONVERSATIONS within a project keeps a background turn alive, but
    // switching PROJECTS cannot: the tool bridge (useAgentToolBridge) is bound to
    // the currently-viewed project, so a background turn's tool calls would run
    // against the wrong project's data. Until the bridge is turn/project-aware
    // (the prerequisite for true concurrency), abort an in-flight turn on a real
    // project change. The tagged `done` it triggers persists its partial
    // transcript and clears the running pointers.
    if (get().runningConvId) {
      void window.electronAPI?.agent?.abort();
    }
    // `runs` (keyed by convId) is intentionally preserved across the switch so an
    // already-finished conversation re-opens instantly without a DB round-trip.
    useAgentActivityStore.getState().clearAll();
    set({ boundProjectId: projectId, activeConvId: null, prompt: '' });
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
      // The project may have changed again (or a conversation opened) while the
      // async list was in flight — bail rather than clobber newer state.
      if (get().boundProjectId !== projectId) return;
      set({ convList: rows });
      const lastId = useSettingsStore.getState().lastAgentConvByProject[projectId];
      // Only restore a conversation that still exists (listByProject already
      // filters soft-deleted rows) and only if the user hasn't opened one.
      if (lastId && !get().activeConvId && rows.some((r) => r.id === lastId)) {
        await get().loadConversation(lastId);
      }
    })();
  },

  send: async () => {
    ensureSubscription();
    const api = window.electronAPI?.agent;
    const s = get();
    // One turn at a time (main runs a single query): refuse if one is in flight,
    // even if it's a background turn in another conversation.
    if (!api || !s.prompt.trim() || !s.boundProjectId || s.runningConvId) return;
    const projectId = s.boundProjectId;
    const text = s.prompt.trim();
    const now = new Date().toISOString();
    const settings = useSettingsStore.getState();
    const auth = settings.agentAuth;
    // The conversation row records only hosted vs byok-ish; oauth/apikey both
    // collapse to 'byok' for that coarse label. The real auth method goes to
    // the SDK via api.start({ mode }).
    const convMode: 'hosted' | 'byok' = auth === 'hosted' ? 'hosted' : 'byok';

    // Lazily create the conversation row on the first message so it shows up in
    // history immediately; the transcript is overwritten on `done`.
    let convId = s.activeConvId;
    if (!convId) {
      convId = uuidv7();
      try {
        await repo.create({
          id: convId,
          projectId,
          title: deriveTitle(text),
          mode: convMode,
          messages: [{ kind: 'user', text }],
          sdkSessionId: null,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        /* persistence is best-effort — chat still works in-memory */
      }
    }
    const cid = convId;

    // Append the user message into this conversation's live run state (seeding a
    // fresh entry if it isn't loaded yet).
    const prevRun = get().runs[cid];
    const run: RunState = {
      projectId,
      messages: [...(prevRun?.messages ?? []), { kind: 'user', text }],
      sdkSessionId: prevRun?.sdkSessionId ?? null,
    };

    const turnId = uuidv7();
    turnConv.set(turnId, cid);
    set((st) => ({
      runs: { ...st.runs, [cid]: run },
      activeConvId: cid,
      prompt: '',
      runningTurnId: turnId,
      runningConvId: cid,
    }));
    // Remember this as the project's last-active conversation so it re-opens on
    // next launch.
    useSettingsStore.getState().setLastAgentConv(projectId, cid);
    get().refreshList();

    // Project writing preferences (KV facts) + writing language, injected into
    // the agent's system prompt so it honors the author's style/POV/length and
    // writes in the manuscript's language. Empty facts → no style steer.
    const project = useProjectStore.getState().currentProject;
    const projectFacts = project && project.id === projectId ? parseKv(project.kvJson) : [];
    const writingLanguage = resolveWritingLanguage(projectId);

    const r = await api.start({
      prompt: text,
      mode: auth,
      model: settings.agentModel,
      effort: settings.agentEffort,
      thinking: settings.agentThinking,
      resume: run.sdkSessionId ?? undefined,
      writingLanguage,
      projectFacts,
      turnId,
    });
    // !ok only fires for pre-flight failures (e.g. auth) that emitted no events
    // for this turn — a turn that started surfaces its own errors via the tagged
    // 'error'/'done' stream. So surface this one and clear the in-flight turn.
    if (!r.ok) {
      turnConv.delete(turnId);
      set((st) => {
        const cur = st.runs[cid];
        const runs = cur
          ? {
              ...st.runs,
              [cid]: { ...cur, messages: [...cur.messages, { kind: 'error' as const, text: r.error }] },
            }
          : st.runs;
        const clearing = st.runningTurnId === turnId;
        return {
          runs,
          ...(clearing ? { runningTurnId: null, runningConvId: null } : {}),
        };
      });
    }
  },

  abort: () => {
    void window.electronAPI?.agent?.abort();
  },

  newConversation: () => {
    void window.electronAPI?.agent?.resetSession();
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
    // Switch the view to a fresh, empty chat. A background turn (if any) keeps
    // running in its own conversation — we don't abort it here.
    set({ activeConvId: null, prompt: '' });
  },

  loadConversation: async (id) => {
    // Don't clobber a conversation that's live in memory (it may be running in
    // the background) with a stale DB snapshot — only hydrate if not loaded.
    if (!get().runs[id]) {
      const conv = await repo.get(id);
      if (!conv) return;
      set((st) => ({
        runs: {
          ...st.runs,
          [id]: {
            projectId: conv.projectId,
            messages: conv.messages,
            sdkSessionId: conv.sdkSessionId,
          },
        },
      }));
    }
    set({ activeConvId: id });
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().setLastAgentConv(pid, id);
  },

  deleteConversation: async (id) => {
    // Abort + clear the in-flight turn if it belongs to the conversation we're
    // deleting (main runs a single query, so abort targets exactly this turn).
    if (get().runningConvId === id) {
      void window.electronAPI?.agent?.abort();
      const tid = get().runningTurnId;
      if (tid) turnConv.delete(tid);
      set({ runningTurnId: null, runningConvId: null });
    }
    try {
      await repo.softDelete(id, new Date().toISOString());
    } catch {
      /* ignore */
    }
    set((st) => {
      if (!(id in st.runs)) return st;
      const runs = { ...st.runs };
      delete runs[id];
      return { runs };
    });
    if (get().activeConvId === id) {
      const pid = get().boundProjectId;
      if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
      set({ activeConvId: null });
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

/** Persist one conversation's live transcript + session id to SQLite. Keyed by
 *  the turn's OWNING conversation, never the displayed one. */
async function persistConv(convId: string): Promise<void> {
  const run = useAgentChatStore.getState().runs[convId];
  if (!run) return;
  try {
    await repo.update(convId, {
      messages: run.messages,
      sdkSessionId: run.sdkSessionId,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort */
  }
  useAgentChatStore.getState().refreshList();
}

function handleEvent(env: AgentEventEnvelope): void {
  const { turnId, event: ev } = env;
  const convId = turnConv.get(turnId);
  if (!convId) return; // foreign / stale turn (e.g. from before a reload) — ignore

  if (ev.type === 'session') {
    useAgentChatStore.setState((s) => {
      const run = s.runs[convId];
      return run ? { runs: { ...s.runs, [convId]: { ...run, sdkSessionId: ev.id } } } : s;
    });
    return;
  }

  // Fold the event into the OWNING conversation's transcript (not the displayed
  // one) — this is what lets a background turn keep streaming after navigation.
  useAgentChatStore.setState((s) => {
    const run = s.runs[convId];
    return run ? { runs: { ...s.runs, [convId]: { ...run, messages: applyEvent(run.messages, ev) } } } : s;
  });

  // Mirror tool activity to the perception store (left-panel pulses + dots) only
  // when the running conversation belongs to the project currently displayed, so
  // a background turn in another project doesn't pulse foreign cells.
  const st = useAgentChatStore.getState();
  const run = st.runs[convId];
  if (run && run.projectId === st.boundProjectId && st.runningConvId === convId) {
    const activity = useAgentActivityStore.getState();
    if (ev.type === 'tool_use') activity.onToolUse(ev.id, ev.name, ev.input);
    else if (ev.type === 'tool_result') activity.onToolResult(ev.id, ev.ok, ev.text);
  }

  if (ev.type === 'done') {
    turnConv.delete(turnId);
    useAgentActivityStore.getState().onTurnEnd();
    useAgentChatStore.setState((s) =>
      s.runningTurnId === turnId ? { runningTurnId: null, runningConvId: null } : s,
    );
    // setState is synchronous, so persistConv sees the finalized transcript.
    void persistConv(convId);
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
