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
 * `done`. New provider-neutral sessions use `runtimeSessionId`. The legacy
 * `sdkSessionId` remains readable on old conversations but is never
 * reinterpreted as a self-hosted runtime session.
 */
import { create } from 'zustand';
import { v7 as uuidv7 } from 'uuid';
import { useSettingsStore } from './settings-store';
import { useProjectStore } from './project-store';
import { useAgentActivityStore } from './agent-activity-store';
import { useDataStore } from './data-store';
import { useAgentEditStore, type RevertRecord } from './agent-edit-store';
import { useAgentCheckpointStore } from './agent-checkpoint-store';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { resolveWritingLanguage } from '../lib/ai/output-language';
import { loadActiveMemoryHints } from '../usecase/useAgentMemory';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import type {
  AgentChatMessage as ChatMsg,
  AgentConversationSummary,
} from '../domain/agent-conversation';
import type {
  AgentControlStatus,
  AgentEvent,
  AgentEventEnvelope,
  AgentPendingControl,
  AgentPermissionScope,
} from '../lib/agent/protocol';
import { loadCanonicalAgentTranscript } from '../lib/agent/runtime/recovered-transcript';
import { buildAgentWriteReviewFeedback } from '../lib/agent/runtime/write-review-feedback';
import { generalAgentTransport } from '../lib/agent/transport';
import { buildGeneralAgentProjectContext } from '../lib/agent/product-project-context';

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
      // Provider call ids are unique within one runtime turn, not necessarily
      // across the whole persisted conversation. Resolve from the newest card
      // so a later turn reusing `call_0` cannot overwrite an old completed card
      // and leave the current one permanently running.
      let idx = -1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const message = list[i];
        if (message?.kind === 'tool' && message.id === ev.id) {
          idx = i;
          break;
        }
      }
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
          durationMs: ev.durationMs,
          durationApiMs: ev.durationApiMs,
          // Stamp the moment usage arrives so the settings panel can scope
          // totals to a time window (this-month vs all-time).
          at: new Date().toISOString(),
        },
      ];
    case 'error':
      return [...finalizeStreaming(list), { kind: 'error', text: ev.message }];
    case 'steering_received':
      return [
        ...finalizeStreaming(list),
        { kind: 'user', text: ev.text },
      ];
    case 'user_input_received':
      return [
        ...finalizeStreaming(list),
        { kind: 'user', text: ev.response.text },
      ];
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
  if (!t) return 'New chat';
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/** Human name for a prose entity, from the in-memory data store (mirrors
 *  tool-handlers' entityLabel). */
function entityDisplayName(entityType: ActivityEntityType, id: string): string {
  const s = useDataStore.getState();
  switch (entityType) {
    case 'node':
      return s.bookNodes.find((n) => n.id === id)?.title ?? id;
    case 'element':
      return s.bookElements.find((e) => e.id === id)?.name ?? id;
    case 'storyline':
      return s.storylines.find((sl) => sl.id === id)?.name ?? id;
    case 'category':
      return s.bookElementCategories.find((c) => c.id === id)?.name ?? id;
    default:
      return id;
  }
}

/** A system note (zh-CN) telling the agent which of its edits the user rejected
 *  since the last turn, so it works from the restored text instead of believing
 *  its edits stuck (it ran bypassPermissions). Prepended to the next prompt. */
function buildRevertNote(reverts: RevertRecord[]): string {
  const clamp = (t: string): string => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
  const lines = reverts.map((rv) => {
    const name = `《${entityDisplayName(rv.entityType, rv.id)}》`;
    // Non-prose field edits (summary / kv / template kv) name the field.
    if (rv.field) {
      const f = rv.field;
      // Patch review: rejecting a CREATE deletes it; a DELETE keeps it; an
      // UPDATE restores the pre-edit title/body.
      if (f.kind === 'patch') {
        if (rv.op === 'deleted')
          return `- 你删除的${name}的补丁「${f.label}」已被用户保留（未删除）。`;
        if (rv.op === 'changed')
          return `- 你对${name}的补丁「${f.label}」的修改已被用户撤销，已还原为改动前的内容。`;
        return `- 你为${name}创建的补丁「${f.label}」已被用户删除。`;
      }
      const fieldLabel =
        f.kind === 'summary'
          ? '摘要'
          : f.kind === 'group'
            ? '分组'
            : f.kind === 'kv'
              ? `字段「${f.key ?? ''}」`
              : f.kind === 'templatekv'
                ? `模版字段「${f.key ?? ''}」`
                : '字段';
      if (rv.op === 'new') return `- 你为${name}新增的${fieldLabel}已被用户撤销（删除）。`;
      if (rv.op === 'deleted')
        return `- 你删除的${name}的${fieldLabel}已被用户恢复为：「${clamp(rv.restoredText)}」。`;
      return `- 你对${name}的${fieldLabel}的修改已被用户拒绝，已恢复为：「${clamp(rv.restoredText)}」。`;
    }
    if (rv.op === 'new') return `- 你在${name}中新增的一个段落已被用户撤销（删除）。`;
    if (rv.op === 'deleted')
      return `- 你在${name}中删除的段落已被用户恢复为原文：「${clamp(rv.restoredText)}」。`;
    return `- 你在${name}中的一处改写已被用户拒绝，已恢复为原文：「${clamp(rv.restoredText)}」。`;
  });
  return `【系统提示】自你上一轮之后，用户拒绝并还原了以下改动。请以还原后的文本为当前内容，未经用户明确要求不要重新应用这些改动：\n${lines.join('\n')}`;
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
  /** Provider-neutral canonical runtime session used for context recovery. */
  runtimeSessionId: string | null;
  controlStatus: AgentControlStatus | null;
  pendingControl: AgentPendingControl | null;
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
  respondPermission: (
    decision: 'allow' | 'deny',
    scope?: AgentPermissionScope,
  ) => Promise<void>;
  stopAfterTool: () => Promise<void>;
  cancelRecoveredControl: () => Promise<void>;
  abort: () => void;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  /** Soft-delete every conversation in the bound project, resetting to a fresh chat. */
  clearConversations: () => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
}

/** The displayed conversation's transcript (stable empty ref when none). */
export const selectMessages = (s: AgentChatState): ChatMsg[] =>
  s.activeConvId ? (s.runs[s.activeConvId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
/** Is the displayed conversation the one with the in-flight turn? */
export const selectRunning = (s: AgentChatState): boolean =>
  s.runningConvId !== null && s.runningConvId === s.activeConvId;
/** A turn is running, but in a DIFFERENT conversation than the one displayed. */
export const selectOtherRunning = (s: AgentChatState): boolean =>
  s.runningConvId !== null && s.runningConvId !== s.activeConvId;
export const selectControlStatus = (s: AgentChatState): AgentControlStatus | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.controlStatus ?? null) : null;
export const selectPendingControl = (s: AgentChatState): AgentPendingControl | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.pendingControl ?? null) : null;

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
      void generalAgentTransport.abort();
    }
    // `runs` (keyed by convId) is intentionally preserved across the switch so an
    // already-finished conversation re-opens instantly without a DB round-trip.
    // Activity (pulses / "M") is session-scoped, so reset it on project switch.
    // The edit-review store is NOT cleared here: it's persisted so unapproved
    // edits survive a reload/navigation (clearing it would silently accept them).
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
    const s = get();
    if (!s.prompt.trim() || !s.boundProjectId) return;
    const displayedRun = s.activeConvId
      ? s.runs[s.activeConvId]
      : undefined;
    if (displayedRun?.pendingControl?.requiresContinuation) return;
    if (s.runningConvId) {
      if (
        s.activeConvId !== s.runningConvId ||
        !s.runningTurnId
      ) {
        return;
      }
      const liveRun = s.runs[s.runningConvId];
      const text = s.prompt.trim();
      const pending = liveRun?.pendingControl;
      if (pending?.requiresContinuation) return;
      const response =
        pending?.status === 'waiting_user' && pending.userInputRequest
          ? await generalAgentTransport.submitUserInput({
              requestId: pending.userInputRequest.requestId,
              sessionId: pending.userInputRequest.sessionId,
              turnId: pending.userInputRequest.turnId,
              callId: pending.userInputRequest.callId,
              text,
            })
          : await generalAgentTransport.steer({
              turnId: s.runningTurnId,
              text,
            });
      if (response.ok) {
        set((current) =>
          current.prompt === s.prompt ? { prompt: '' } : current,
        );
      } else {
        appendRunError(s.runningConvId, response.error);
      }
      return;
    }
    const projectId = s.boundProjectId;
    const text = s.prompt.trim();
    // Drain edits the user rejected since the last turn and prepend them as a
    // system note for the SDK only — so the agent works from the restored text.
    // Drained AFTER the guard (an aborted send must not silently consume them);
    // the visible transcript keeps the ORIGINAL text, only the SDK prompt is
    // prefixed.
    const reverts = useAgentEditStore.getState().drainReverts(projectId);
    const runtimeSessionId = s.activeConvId
      ? s.runs[s.activeConvId]?.runtimeSessionId
      : null;
    let canonicalReviewFeedback = '';
    if (runtimeSessionId) {
      try {
        canonicalReviewFeedback =
          await buildAgentWriteReviewFeedback(runtimeSessionId);
      } catch {
        // Review feedback is advisory prompt context. Durable write/revert
        // enforcement remains in the coordinator even if this read is
        // temporarily unavailable.
      }
    }
    const promptNotes = [
      ...(reverts.length ? [buildRevertNote(reverts)] : []),
      ...(canonicalReviewFeedback ? [canonicalReviewFeedback] : []),
    ];
    const promptToSend = promptNotes.length
      ? `${promptNotes.join('\n\n')}\n\n${text}`
      : text;
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
          runtimeSessionId: null,
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
      runtimeSessionId: prevRun?.runtimeSessionId ?? null,
      controlStatus: null,
      pendingControl: null,
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
    // A prompt is accepted once it leaves the composer. Persist that user
    // message before model startup so a crash, auth failure, or app restart
    // cannot erase it merely because no terminal `done` event arrived.
    try {
      await repo.update(cid, {
        messages: run.messages,
        updatedAt: now,
      });
    } catch {
      /* persistence is best-effort — the in-memory transcript remains usable */
    }
    // Open this turn's checkpoint: writes the agent makes are folded into it so
    // the user can later revert the whole turn (see lib/agent/turn-revert).
    useAgentCheckpointStore.getState().beginTurn({
      turnId,
      convId: cid,
      projectId,
      label: text.length > 48 ? `${text.slice(0, 48)}…` : text,
    });
    // Remember this as the project's last-active conversation so it re-opens on
    // next launch.
    useSettingsStore.getState().setLastAgentConv(projectId, cid);
    get().refreshList();

    // Project writing preferences (KV facts) + writing language, injected into
    // the agent's system prompt so it honors the author's style/POV/length and
    // writes in the manuscript's language. Empty facts → no style steer.
    const project = useProjectStore.getState().currentProject;
    const projectContext = buildGeneralAgentProjectContext(projectId, project);
    const writingLanguage = resolveWritingLanguage(projectId);
    // Active agent memories (author-approved standing guidance) — injected into
    // the system prompt so past preferences/vetoes/directives keep steering.
    const memories = await loadActiveMemoryHints(projectId).catch(() => []);

    const r = await generalAgentTransport.start({
      prompt: promptToSend,
      route: { kind: 'chat', projectId, conversationId: cid },
      projectId,
      mode: auth,
      model: settings.agentModel,
      effort: settings.agentEffort,
      thinking: settings.agentThinking,
      toolSearch: settings.agentToolSearch,
      resume: run.runtimeSessionId ?? undefined,
      ...projectContext,
      writingLanguage,
      memories,
      turnId,
    });
    // !ok only fires for pre-flight failures (e.g. auth) that emitted no events
    // for this turn — a turn that started surfaces its own errors via the tagged
    // 'error'/'done' stream. So surface this one and clear the in-flight turn.
    if (!r.ok) {
      turnConv.delete(turnId);
      useAgentCheckpointStore.getState().endTurn(turnId);
      set((st) => {
        const cur = st.runs[cid];
        const runs = cur
          ? {
              ...st.runs,
              [cid]: {
                ...cur,
                messages: [...cur.messages, { kind: 'error' as const, text: r.error }],
              },
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

  respondPermission: async (decision, requestedScope = 'once') => {
    const s = get();
    const convId = s.activeConvId;
    const pending = convId ? s.runs[convId]?.pendingControl : null;
    const request = pending?.permissionRequest;
    if (
      !convId ||
      !request ||
      pending.requiresContinuation ||
      !request.allowedScopes.includes(requestedScope)
    ) {
      return;
    }
    const response = await generalAgentTransport.resolvePermission({
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      callId: request.callId,
      argumentsHash: request.argumentsHash,
      revision: request.revision,
      decision,
      scope: requestedScope,
    });
    if (!response.ok) appendRunError(convId, response.error);
  },

  stopAfterTool: async () => {
    const s = get();
    if (!s.runningTurnId || !s.runningConvId) return;
    const response = await generalAgentTransport.stopAfterTool({
      turnId: s.runningTurnId,
    });
    if (!response.ok) appendRunError(s.runningConvId, response.error);
  },

  cancelRecoveredControl: async () => {
    const s = get();
    const convId = s.activeConvId;
    const pending = convId ? s.runs[convId]?.pendingControl : null;
    const request =
      pending?.permissionRequest ?? pending?.userInputRequest;
    if (!convId || !pending?.requiresContinuation || !request) return;
    const response = await generalAgentTransport.cancelPendingControl({
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      requestId: request.requestId,
      reason: 'Recovered Agent wait cancelled by the author',
    });
    if (!response.ok) {
      appendRunError(convId, response.error);
      return;
    }
    set((state) => {
      const run = state.runs[convId];
      if (!run || run.pendingControl?.turnId !== pending.turnId) return state;
      return {
        runs: {
          ...state.runs,
          [convId]: {
            ...run,
            controlStatus: null,
            pendingControl: null,
          },
        },
      };
    });
  },

  abort: () => {
    void generalAgentTransport.abort();
  },

  newConversation: () => {
    void generalAgentTransport.resetSession();
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
      let messages = conv.messages;
      if (conv.runtimeSessionId) {
        try {
          messages =
            (await loadCanonicalAgentTranscript(conv.runtimeSessionId)) ??
            messages;
        } catch {
          // A corrupt/unavailable canonical session must never be fed back to
          // the model. The display cache is still useful as a read-only
          // fallback while the transport refuses that resume.
        }
      }
      set((st) => ({
        runs: {
          ...st.runs,
          [id]: {
            projectId: conv.projectId,
            messages,
            runtimeSessionId: conv.runtimeSessionId,
            controlStatus: null,
            pendingControl: null,
          },
        },
      }));
    }
    set({ activeConvId: id });
    const runtimeSessionId = get().runs[id]?.runtimeSessionId;
    if (runtimeSessionId) {
      const pending = await generalAgentTransport.listPendingControls({
        sessionId: runtimeSessionId,
      });
      if (pending.ok) {
        const recovered = pending.value[0] ?? null;
        set((state) => {
          const run = state.runs[id];
          if (!run || run.runtimeSessionId !== runtimeSessionId) return state;
          return {
            runs: {
              ...state.runs,
              [id]: {
                ...run,
                controlStatus: recovered?.status ?? null,
                pendingControl: recovered,
              },
            },
          };
        });
      }
    }
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().setLastAgentConv(pid, id);
  },

  deleteConversation: async (id) => {
    // Abort + clear the in-flight turn if it belongs to the conversation we're
    // deleting (main runs a single query, so abort targets exactly this turn).
    if (get().runningConvId === id) {
      void generalAgentTransport.abort();
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

  clearConversations: async () => {
    const pid = get().boundProjectId;
    if (!pid) return;
    // Abort + clear the in-flight turn (main runs a single query, so abort
    // targets exactly it) — its conversation is about to be deleted too.
    if (get().runningConvId) {
      void generalAgentTransport.abort();
      const tid = get().runningTurnId;
      if (tid) turnConv.delete(tid);
      set({ runningTurnId: null, runningConvId: null });
    }
    try {
      await repo.softDeleteAllByProject(pid, new Date().toISOString());
    } catch {
      /* ignore */
    }
    // Drop this project's in-memory transcripts (other projects' caches stay)
    // and reset the view to a fresh chat.
    useSettingsStore.getState().clearLastAgentConv(pid);
    set((st) => ({
      runs: Object.fromEntries(Object.entries(st.runs).filter(([, r]) => r.projectId !== pid)),
      activeConvId: null,
    }));
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
      runtimeSessionId: run.runtimeSessionId,
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
      return run
        ? {
            runs: {
              ...s.runs,
              [convId]: { ...run, runtimeSessionId: ev.id },
            },
          }
        : s;
    });
    return;
  }

  // Fold the event and its canonical control projection into the OWNING
  // conversation (not necessarily the displayed one).
  useAgentChatStore.setState((s) => {
    const run = s.runs[convId];
    if (!run) return s;
    let controlStatus = run.controlStatus;
    let pendingControl = run.pendingControl;
    if (ev.type === 'control_state') {
      controlStatus = ev.status;
    } else if (ev.type === 'permission_request') {
      controlStatus = 'waiting_permission';
      pendingControl = {
        sessionId: ev.request.sessionId,
        turnId: ev.request.turnId,
        status: 'waiting_permission',
        permissionRequest: ev.request,
        requiresContinuation: false,
      };
    } else if (ev.type === 'permission_resolved') {
      if (
        pendingControl?.permissionRequest?.requestId ===
        ev.resolution.requestId
      ) {
        pendingControl = null;
      }
    } else if (ev.type === 'user_input_request') {
      controlStatus = 'waiting_user';
      pendingControl = {
        sessionId: ev.request.sessionId,
        turnId: ev.request.turnId,
        status: 'waiting_user',
        userInputRequest: ev.request,
        requiresContinuation: false,
      };
    } else if (ev.type === 'user_input_received') {
      if (
        pendingControl?.userInputRequest?.requestId ===
        ev.response.requestId
      ) {
        pendingControl = null;
      }
    } else if (ev.type === 'done') {
      controlStatus = null;
      pendingControl = null;
    }
    return {
      runs: {
        ...s.runs,
        [convId]: {
          ...run,
          messages: applyEvent(run.messages, ev),
          controlStatus,
          pendingControl,
        },
      },
    };
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
    useAgentCheckpointStore.getState().endTurn(turnId);
    useAgentActivityStore.getState().onTurnEnd();
    useAgentChatStore.setState((s) =>
      s.runningTurnId === turnId ? { runningTurnId: null, runningConvId: null } : s,
    );
    // setState is synchronous, so persistConv sees the finalized transcript.
    void persistConv(convId);
  }
}

let subscribed = false;

function appendRunError(convId: string, message: string): void {
  useAgentChatStore.setState((state) => {
    const run = state.runs[convId];
    if (!run) return state;
    return {
      runs: {
        ...state.runs,
        [convId]: {
          ...run,
          messages: [
            ...finalizeStreaming(run.messages),
            { kind: 'error', text: message },
          ],
        },
      },
    };
  });
}

/** Subscribe to agent events once for the app's lifetime (never torn down, so
 *  streaming survives the panel unmounting). Idempotent. */
function ensureSubscription(): void {
  if (subscribed) return;
  const subscription = generalAgentTransport.subscribeEvents(handleEvent);
  if (!subscription.ok) return;
  subscribed = true;
}
