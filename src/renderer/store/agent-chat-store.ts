import { AgentChatTranscript } from '../domain/agent-chat-transcript';
/**
 * Agent chat store (module-level, in-memory).
 *
 * Holds the right-sidebar Agent conversations so they survive the panel
 * unmounting/remounting when the user switches sidebar tabs — the view is a thin
 * projection of this store. The single agent-event subscription also lives here
 * (set up once), so streaming keeps flowing and the canonical terminal entry
 * still persists even while
 * the panel isn't mounted.
 *
 * Per-conversation live state lives in `runs` (keyed by convId), which decouples
 * "which conversation is displayed" (`activeConvId`) from "which conversation a
 * streamed event belongs to" (resolved by the app-owned journal consumer).
 * That decoupling is what lets a turn keep running in the background: switching
 * conversation or project changes only the displayed `runs` entry; the in-flight
 * turn keeps folding into — and on `turn_finished` persists to — its OWN
 * conversation.
 *
 * Display transcript is persisted to SQLite (agent_conversation) on each
 * canonical `turn_finished`. New provider-neutral sessions use
 * `runtimeSessionId`. The legacy
 * `sdkSessionId` remains readable on old conversations but is never
 * reinterpreted as a self-hosted runtime session.
 */
import { create } from 'zustand';
import { events } from '../lib/events';
import { AgentConversationSyncRepository } from '../sync/agent-chat/repository';
import { v7 as uuidv7 } from 'uuid';
import { useSettingsStore } from './settings-store';
import { useProjectStore } from './project-store';
import { useAgentActivityStore } from './agent-activity-store';
import { useDataStore } from './data-store';
import { useAgentEditStore, type RevertRecord } from './agent-edit-store';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { loadActiveMemoryHints } from '../usecase/useAgentMemory';
import { prepareAgentWorkingMemoryForTurn } from '../usecase/useAgentWorkingMemory';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import { createAgentRuntimeLongTaskRepository } from '../sqlite-repo/agent-runtime-long-task-repo';
import type {
  AgentChatMessage as ChatMsg,
  AgentConversationContextRef,
  AgentConversationSummary,
} from '../domain/agent-conversation';
import type {
  AgentControlStatus,
  AgentPendingControl,
  AgentPermissionScope,
} from '../lib/agent/protocol';
import type {
  AgentContextUsageSnapshot,
} from '../lib/agent/runtime/types';
import {
  applyAgentChatJournalEntry,
  finalizeAgentChatTranscript,
} from '../lib/agent/runtime/chat-journal-projection';
import {
  findCanonicalAgentChatSessionId,
  loadCanonicalAgentChatProjection,
} from '../lib/agent/runtime/recovered-transcript';
import {
  armAgentAutomaticContinuation,
  beginAutomaticContinuationSlice,
  createInactiveAgentAutomaticContinuation,
  decideAgentAutomaticContinuation,
  observeAgentAutomaticContinuationProgress,
  summarizeLongTaskPlanForContinuation,
  type AgentAutomaticContinuationState,
  type AgentLongTaskPlanContinuationState,
} from '../lib/agent/runtime/long-task-auto-continuation';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createAgentChatJournalConsumer } from '../lib/agent/runtime/chat-journal-consumer';
import type { AgentChatRunState as RunState, AgentChatTerminalState as RunTerminalState } from '../lib/agent/runtime/chat-run-projection';
import { generalAgentTransport } from '../lib/agent/transport';
import { buildGeneralAgentProjectContext } from '../lib/agent/product-project-context';
import { agentTurnContextPrompt, normalizeAgentTurnContext } from '../lib/agent/turn-context';

const repo = createAgentConversationRepository();
const longTaskRepo = createAgentRuntimeLongTaskRepository();

// The removed legacy whole-turn checkpoint store was localStorage-backed.
// Retire its persisted payload when the Agent surface first loads.
try {
  globalThis.localStorage?.removeItem('agent-turn-checkpoints');
} catch {
  // Storage may be unavailable in privacy-restricted webviews.
}

// ---- transcript reducer (pure) --------------------------------------------

export const applyEvent = applyAgentChatJournalEntry;

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
export const BUDGET_CONTINUATION_PROMPT =
  '继续完成上一轮在上下文边界处续接的任务。先检查上一轮已完成的工作和当前项目状态，不要重复已完成的步骤；从尚未完成的部分继续，完成后总结结果。';
export const ACTIVE_PLAN_CONTINUATION_PROMPT =
  '继续执行当前持久化任务计划。先用 read_task_plan 读取计划、约束和当前项目状态，不要重复已完成的步骤；只能用 update_task_step 更新单个步骤状态，update_task_plan 只处理任务级状态。从第一个尚未完成的步骤继续。如果所有步骤已经完成且任务仍为 active，必须先用 update_task_plan 的 set_status 将任务设为 completed，再给最终总结；不要只口头宣布完成。';

type RunLongTaskPlanState = AgentLongTaskPlanContinuationState;

export type AgentChatSendOrigin =
  | 'author'
  | 'author_continuation'
  | 'automatic_continuation'
  | 'headless_once'
  | 'headless_auto';

export interface AgentChatSendOptions {
  /** Omitted calls come from the visible composer and count as author intent. */
  origin?: AgentChatSendOrigin;
  /** Product-owned model instruction that must never appear in the composer. */
  runtimePrompt?: string;
  /** Visible, durable context selected by the author-facing composer. */
  turnContext?: readonly AgentConversationContextRef[];
  /** Mobile Answer mode removes every write tool at the runtime boundary. */
  toolAccess?: 'read_only' | 'read_write';
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
  /** Compatibility pointer to the most recently foregrounded in-flight turn. */
  runningTurnId: string | null;
  /** Compatibility pointer paired with runningTurnId. */
  runningConvId: string | null;
  /** Canonical concurrency state: conversation id → its one active turn id. */
  runningTurns: Record<string, string>;
  /**
   * Synchronous startup mutex held before any repository/provider await.
   * Without it, double Send/Continue can both pass the idle guard and overwrite
   * the single in-flight turn pointers.
   */
  starting: boolean;

  setPrompt: (p: string) => void;
  /** Mount/route hook: switch to this project's history. Background runs and the
   *  in-flight turn are preserved across the switch. */
  bindProject: (projectId: string, options?: { restoreLastConversation?: boolean }) => void;
  refreshList: () => void;
  send: (options?: AgentChatSendOptions) => Promise<void>;
  /** Re-authorize continuous execution for the current durable task. */
  continueTask: () => Promise<void>;
  respondPermission: (decision: 'allow' | 'deny', scope?: AgentPermissionScope) => Promise<void>;
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
  s.activeConvId ? (s.runs[s.activeConvId]?.transcript.toArray() ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
/** Is the displayed conversation the one with the in-flight turn? */
export const selectRunning = (s: AgentChatState): boolean =>
  s.activeConvId !== null && Boolean(s.runningTurns[s.activeConvId]);
/** At least one turn is running in a different conversation than the one displayed. */
export const selectOtherRunning = (s: AgentChatState): boolean =>
  Object.keys(s.runningTurns).some((convId) => convId !== s.activeConvId);
export const selectOtherRunningConversationId = (s: AgentChatState): string | null =>
  Object.keys(s.runningTurns).find((convId) => convId !== s.activeConvId) ?? null;
export const selectControlStatus = (s: AgentChatState): AgentControlStatus | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.controlStatus ?? null) : null;
export const selectPendingControl = (s: AgentChatState): AgentPendingControl | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.pendingControl ?? null) : null;
export const selectContextUsage = (s: AgentChatState): AgentContextUsageSnapshot | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.contextUsage ?? null) : null;
export const selectAutomaticContinuation = (
  s: AgentChatState,
): AgentAutomaticContinuationState | null =>
  s.activeConvId ? (s.runs[s.activeConvId]?.automaticContinuation ?? null) : null;
export type AgentTaskContinuationReason = 'budget_exceeded' | 'active_plan';
export const selectAgentTaskContinuationReason = (
  s: AgentChatState,
): AgentTaskContinuationReason | null => {
  const run = s.activeConvId ? s.runs[s.activeConvId] : undefined;
  if (
    s.starting ||
    (s.activeConvId !== null && Boolean(s.runningTurns[s.activeConvId])) ||
    run?.pendingControl ||
    s.prompt?.trim()
  ) {
    return null;
  }
  if (
    run?.automaticContinuation?.status === 'armed' ||
    run?.automaticContinuation?.status === 'evaluating' ||
    run?.automaticContinuation?.status === 'scheduled'
  ) {
    return null;
  }
  if (
    !run ||
    run.runtimeSessionId === null ||
    run.longTaskPlanState?.sessionId !== run.runtimeSessionId
  ) {
    return null;
  }
  const planStatus = run.longTaskPlanState.status;
  if (run.lastTerminal?.outcome === 'budget_exceeded') {
    // A budget-only task without a plan remains manually continuable. A plan
    // must be explicitly active; paused/blocked require a distinct author
    // decision, while terminal states prove no continuation remains.
    return planStatus === 'none' || planStatus === 'active' ? 'budget_exceeded' : null;
  }
  if (run.lastTerminal && planStatus === 'active') {
    return 'active_plan';
  }
  return null;
};
export const selectCanContinueAgentTask = (s: AgentChatState): boolean =>
  selectAgentTaskContinuationReason(s) !== null;

const automaticContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function runningPointers(runningTurns: Record<string, string>): {
  runningTurnId: string | null;
  runningConvId: string | null;
} {
  const entries = Object.entries(runningTurns);
  const latest = entries[entries.length - 1];
  return latest
    ? { runningConvId: latest[0], runningTurnId: latest[1] }
    : { runningConvId: null, runningTurnId: null };
}

function withoutRunningTurn(
  state: Pick<AgentChatState, 'runningTurns'>,
  convId: string,
  turnId: string,
): Pick<AgentChatState, 'runningTurns' | 'runningTurnId' | 'runningConvId'> | null {
  if (state.runningTurns[convId] !== turnId) return null;
  const runningTurns = { ...state.runningTurns };
  delete runningTurns[convId];
  return { runningTurns, ...runningPointers(runningTurns) };
}

export interface AgentConversationLoadToken {
  generation: number;
  projectId: string;
}

/** Latest-intent gate for asynchronous conversation hydration. */
export class AgentConversationLoadGuard {
  private generation = 0;

  begin(projectId: string): AgentConversationLoadToken {
    this.generation += 1;
    return { generation: this.generation, projectId };
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: AgentConversationLoadToken, currentProjectId: string | null): boolean {
    return token.generation === this.generation && token.projectId === currentProjectId;
  }
}

const conversationLoadGuard = new AgentConversationLoadGuard();
const conversationStartGuard = new AgentConversationLoadGuard();

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  boundProjectId: null,
  activeConvId: null,
  runs: {},
  prompt: '',
  convList: [],
  runningTurnId: null,
  runningConvId: null,
  runningTurns: {},
  starting: false,

  setPrompt: (p) => set({ prompt: p }),

  refreshList: () => {
    const pid = get().boundProjectId;
    if (!pid) return;
    void repo
      .listByProject(pid)
      .then((rows) => { if (get().boundProjectId === pid) set({ convList: rows }); })
      .catch(() => { if (get().boundProjectId === pid) set({ convList: [] }); });
  },

  bindProject: (projectId, options) => {
    ensureSubscription();
    if (get().boundProjectId === projectId) {
      // Same project (e.g. a remount) — keep the live transcript, just refresh.
      get().refreshList();
      return;
    }
    conversationLoadGuard.invalidate();
    conversationStartGuard.invalidate();
    const leavingConvId = get().activeConvId;
    if (leavingConvId) {
      pauseAutomaticContinuationForConversation(leavingConvId, 'author_navigated');
    }
    // Switching CONVERSATIONS within a project keeps a background turn alive, but
    // switching PROJECTS cannot: the tool bridge (useAgentToolBridge) is bound to
    // the currently-viewed project, so a background turn's tool calls would run
    // against the wrong project's data. Until the bridge is turn/project-aware,
    // cross-project concurrency stays fail-closed: abort every foreign turn on
    // a real project change. Same-project sibling conversations remain fully
    // concurrent. Tagged terminal journal entries persist their partial
    // transcripts and clear only their own running pointers.
    for (const [convId, turnId] of Object.entries(get().runningTurns)) {
      if (get().runs[convId]?.projectId !== projectId) {
        void generalAgentTransport.abort({ turnId });
      }
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
      if (options?.restoreLastConversation !== false && lastId && !get().activeConvId && rows.some((r) => r.id === lastId)) {
        await get().loadConversation(lastId);
      }
    })();
  },

  send: async (options) => {
    ensureSubscription();
    const origin = options?.origin ?? 'author';
    const s = get();
    const submittedPrompt = options?.runtimePrompt ?? s.prompt;
    if (s.starting || !submittedPrompt.trim() || !s.boundProjectId) return;
    const displayedRun = s.activeConvId ? s.runs[s.activeConvId] : undefined;
    if (displayedRun?.pendingControl?.requiresContinuation) return;
    const activeTurnId = s.activeConvId ? s.runningTurns[s.activeConvId] : undefined;
    if (s.activeConvId && activeTurnId) {
      const activeConversationId = s.activeConvId;
      const liveRun = s.runs[activeConversationId];
      const text = submittedPrompt.trim();
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
              turnId: activeTurnId,
              text,
            });
      if (response.ok) {
        set((current) =>
          options?.runtimePrompt === undefined && current.prompt === s.prompt
            ? { prompt: '' }
            : current,
        );
      } else {
        appendRunError(activeConversationId, response.error);
      }
      return;
    }
    // Claim startup before the first await. `continueTask` and the
    // ordinary composer share this exact gate.
    conversationLoadGuard.invalidate();
    const startToken = conversationStartGuard.begin(s.boundProjectId);
    const isCurrentStart = (): boolean =>
      conversationStartGuard.isCurrent(startToken, get().boundProjectId);
    set({ starting: true });
    try {
      const projectId = s.boundProjectId;
      const text = submittedPrompt.trim();
      const turnContext = normalizeAgentTurnContext(options?.turnContext);
      const userMessage = {
        kind: 'user' as const,
        text,
        at: new Date().toISOString(),
        ...(turnContext.length > 0 ? { context: turnContext } : {}),
      };
      const isRuntimeContinuation =
        origin === 'author_continuation' || origin === 'automatic_continuation';
      // Preserve an explicit cancellable startup boundary even when no product
      // preflight read is needed. New Chat / Load Conversation can invalidate
      // this intent before the stale prompt is appended to either transcript.
      await Promise.resolve();
      if (!isCurrentStart()) return;
      const now = userMessage.at;
      const settings = useSettingsStore.getState();
      const auth = settings.agentAuth;
      // The conversation row records only hosted vs byok-ish; oauth/apikey both
      // collapse to 'byok' for that coarse label. The real auth method goes to
      // the SDK via api.start({ mode }).
      const convMode: 'hosted' | 'byok' = auth === 'hosted' ? 'hosted' : 'byok';

      // Lazily create the conversation row on the first message so it shows up in
      // history immediately; the transcript is overwritten on `turn_finished`.
      let convId = s.activeConvId;
      if (!convId) {
        convId = uuidv7();
        try {
          await repo.create({
            id: convId,
            projectId,
            title: deriveTitle(text),
            mode: convMode,
            messages: isRuntimeContinuation ? [] : [userMessage],
            sdkSessionId: null,
            runtimeSessionId: null,
            createdAt: now,
            updatedAt: now,
          });
        } catch {
          /* persistence is best-effort — chat still works in-memory */
        }
        if (!isCurrentStart()) return;
      }
      const previousId = convId;
      try {
        convId = await new AgentConversationSyncRepository().forkForContinuation(convId);
      } catch (error) {
        appendRunError(convId, error instanceof Error ? error.message : String(error));
        return;
      }
      if (!isCurrentStart()) return;
      if (convId !== previousId) {
        const previous = get().runs[previousId];
        if (previous) set((state) => ({ runs: { ...state.runs, [convId!]: { ...previous, runtimeSessionId: null, journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null, longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() } } }));
      }
      const cid = convId;

      // Append the user message into this conversation's live run state (seeding a
      // fresh entry if it isn't loaded yet).
      const prevRun = get().runs[cid];
      cancelAutomaticContinuationTimer(cid);
      const previousAutomatic =
        prevRun?.automaticContinuation ?? createInactiveAgentAutomaticContinuation();
      const toolAccess = options?.toolAccess ?? 'read_write';
      const automaticContinuation =
        toolAccess === 'read_only'
          ? createInactiveAgentAutomaticContinuation(previousAutomatic.sequenceId + 1)
          : origin === 'automatic_continuation'
            ? beginAutomaticContinuationSlice(previousAutomatic)
            : origin === 'headless_once'
              ? createInactiveAgentAutomaticContinuation(previousAutomatic.sequenceId + 1)
              : armAgentAutomaticContinuation(previousAutomatic, Date.now());
      const run: RunState = {
        projectId,
        transcript: isRuntimeContinuation
          ? (prevRun?.transcript ?? AgentChatTranscript.from([]))
          : (prevRun?.transcript ?? AgentChatTranscript.from([])).append(userMessage),
        runtimeSessionId: prevRun?.runtimeSessionId ?? null,
        journalScope: prevRun?.journalScope ?? createAgentChatJournalScope(),
        controlStatus: null,
        pendingControl: null,
        // Keep the previous terminal until the canonical turn_started entry is
        // accepted. If provider preflight fails, the manual continuation remains
        // available instead of disappearing on an unstarted attempt.
        lastTerminal: prevRun?.lastTerminal ?? null,
        longTaskPlanState: prevRun?.longTaskPlanState ?? null,
        contextUsage: prevRun?.contextUsage ?? null,
        automaticContinuation,
      };

      const turnId = uuidv7();
      journalConsumer.registerTurn(turnId, cid);
      set((st) => ({
        runs: { ...st.runs, [cid]: run },
        activeConvId: cid,
        prompt: options?.runtimePrompt === undefined ? '' : st.prompt,
        runningTurns: { ...st.runningTurns, [cid]: turnId },
        runningTurnId: turnId,
        runningConvId: cid,
      }));
      // A prompt is accepted once it leaves the composer. Persist that user
      // message before model startup so a crash, auth failure, or app restart
      // cannot erase it merely because no terminal journal entry arrived.
      try {
        await repo.update(cid, {
          messages: run.transcript.toArray(),
          updatedAt: now,
        });
      } catch {
        /* persistence is best-effort — the in-memory transcript remains usable */
      }
      const discardPreparedTurn = (): void => {
        journalConsumer.releaseTurn(turnId);
        set((state) => withoutRunningTurn(state, cid, turnId) ?? state);
      };
      if (!isCurrentStart()) {
        discardPreparedTurn();
        return;
      }
      // Remember this as the project's last-active conversation so it re-opens on
      // next launch.
      useSettingsStore.getState().setLastAgentConv(projectId, cid);
      get().refreshList();

      // Author-owned project facts/rules are injected verbatim. The product does
      // not derive style, POV, target scope, or other writing policy here.
      const project = useProjectStore.getState().currentProject;
      const projectContext = buildGeneralAgentProjectContext(projectId, project);
      // Active agent memories (author-approved standing guidance) — injected into
      // the system prompt so past preferences/vetoes/directives keep steering.
      const memories = await loadActiveMemoryHints(projectId).catch(() => []);
      const workingMemory = await prepareAgentWorkingMemoryForTurn(projectId).catch(() => null);

      // Drain rejected edits only once all cancellable preflight reads are done.
      // The visible transcript keeps the original user text; only the provider
      // prompt receives this system context.
      const reverts = useAgentEditStore
        .getState()
        .drainReverts(projectId, run.runtimeSessionId);
      // Durable write-review decisions are first-class pinned context rows in
      // the product composition. Do not duplicate them into every user prompt;
      // that legacy path grew long tasks quadratically and blurred authorship.
      const promptNotes = reverts.length ? [buildRevertNote(reverts)] : [];
      const visibleContextNote = agentTurnContextPrompt(turnContext);
      if (visibleContextNote) promptNotes.push(visibleContextNote);
      const promptToSend = promptNotes.length ? `${promptNotes.join('\n\n')}\n\n${text}` : text;
      const r = await generalAgentTransport
        .start({
          prompt: promptToSend,
          promptSource: isRuntimeContinuation ? 'runtime_continuation' : 'author',
          route: { kind: 'chat', projectId, conversationId: cid },
          projectId,
          mode: auth,
          provider: settings.agentProvider,
          model: settings.agentModel,
          contextMode: settings.agentMaxContext ? 'max' : 'standard',
          effort: settings.agentEffort,
          thinking: settings.agentThinking,
          // The runtime always consults the product selection strategy; the
          // author's persisted `agentToolSearch` preference is applied there
          // (off = complete stable surface, auto/on = bounded author-domain
          // relevance selection), so runtime-level bypass is not a user mode.
          toolSearch: 'on',
          toolAccess,
          resume: run.runtimeSessionId ?? undefined,
          ...projectContext,
          memories,
          workingMemory: workingMemory
            ? {
                contentMd: workingMemory.contentMd,
                revision: workingMemory.revision,
                approxTokens: workingMemory.approxTokens,
              }
            : { contentMd: '', revision: 0, approxTokens: 0 },
          turnId,
        })
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'AGENT_RUNTIME_START_FAILED',
          error: error instanceof Error ? error.message : 'Agent Runtime failed to start.',
        }));
      if (!isCurrentStart()) {
        discardPreparedTurn();
        return;
      }
      // !ok only fires for pre-flight failures (e.g. auth) that emitted no events
      // for this turn — a turn that started surfaces its own terminal state via
      // the canonical journal. So surface this one and clear the in-flight turn.
      if (!r.ok) {
        journalConsumer.releaseTurn(turnId);
        set((st) => {
          const cur = st.runs[cid];
          const runs = cur
            ? {
                ...st.runs,
                [cid]: {
                  ...cur,
                  transcript: cur.transcript.append({ kind: 'error', text: r.error }),
                  automaticContinuation:
                    cur.automaticContinuation.status === 'off'
                      ? cur.automaticContinuation
                      : {
                          ...cur.automaticContinuation,
                          status: 'paused' as const,
                          stopReason: 'start_failed' as const,
                        },
                },
              }
            : st.runs;
          const cleared = withoutRunningTurn(st, cid, turnId);
          return {
            runs,
            ...(cleared
              ? {
                  ...cleared,
                  starting: false,
                }
              : {}),
          };
        });
      }
    } finally {
      set((state) => (state.starting ? { starting: false } : state));
    }
  },

  continueTask: async () => {
    const state = get();
    const reason = selectAgentTaskContinuationReason(state);
    if (!reason) return;
    await get().send({
      origin: 'author_continuation',
      runtimePrompt:
        reason === 'budget_exceeded' ? BUDGET_CONTINUATION_PROMPT : ACTIVE_PLAN_CONTINUATION_PROMPT,
    });
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
    const convId = s.activeConvId;
    if (convId) pauseAutomaticContinuationForConversation(convId, 'author_stopped');
    const turnId = convId ? s.runningTurns[convId] : undefined;
    if (!convId || !turnId) return;
    const response = await generalAgentTransport.stopAfterTool({
      turnId,
    });
    if (!response.ok) appendRunError(convId, response.error);
  },

  cancelRecoveredControl: async () => {
    const s = get();
    const convId = s.activeConvId;
    const pending = convId ? s.runs[convId]?.pendingControl : null;
    const request = pending?.permissionRequest ?? pending?.userInputRequest;
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
    const s = get();
    const convId = s.activeConvId;
    if (convId) pauseAutomaticContinuationForConversation(convId, 'author_stopped');
    const turnId = convId ? s.runningTurns[convId] : undefined;
    if (turnId) void generalAgentTransport.abort({ turnId });
  },

  newConversation: () => {
    const activeConvId = get().activeConvId;
    if (activeConvId) {
      pauseAutomaticContinuationForConversation(activeConvId, 'author_navigated');
    }
    conversationLoadGuard.invalidate();
    conversationStartGuard.invalidate();
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
    // Switch the view to a fresh, empty chat. A background turn (if any) keeps
    // running in its own conversation — we don't abort it here.
    set({ activeConvId: null, prompt: '' });
  },

  loadConversation: async (id) => {
    const boundProjectId = get().boundProjectId;
    if (!boundProjectId) return;
    const previousActiveConvId = get().activeConvId;
    if (previousActiveConvId && previousActiveConvId !== id) {
      pauseAutomaticContinuationForConversation(previousActiveConvId, 'author_navigated');
    }
    conversationStartGuard.invalidate();
    const loadToken = conversationLoadGuard.begin(boundProjectId);
    const isCurrentLoad = (): boolean =>
      conversationLoadGuard.isCurrent(loadToken, get().boundProjectId);
    // Don't clobber a conversation that's live in memory (it may be running in
    // the background) with a stale DB snapshot — only hydrate if not loaded.
    const loadedRun = get().runs[id];
    if (loadedRun && loadedRun.projectId !== boundProjectId) return;
    if (!loadedRun) {
      const conv = await repo.get(id);
      if (!isCurrentLoad() || !conv || conv.projectId !== boundProjectId) {
        return;
      }
      let messages = conv.messages;
      let journalScope = createAgentChatJournalScope();
      let lastTerminal: RunTerminalState | null = null;
      let runtimeSessionId = conv.runtimeSessionId;
      let longTaskPlanState: RunLongTaskPlanState | null = null;
      let contextUsage: AgentContextUsageSnapshot | null = null;
      if (!runtimeSessionId) {
        try {
          runtimeSessionId = await findCanonicalAgentChatSessionId(conv.projectId, conv.id);
        } catch {
          runtimeSessionId = null;
        }
        if (!isCurrentLoad()) return;
      }
      if (runtimeSessionId) {
        try {
          const projection = await loadCanonicalAgentChatProjection(
            runtimeSessionId,
            undefined,
            conv.messages,
          );
          if (projection) {
            messages = projection.messages;
            journalScope = createAgentChatJournalScope(projection.eventIds);
            lastTerminal = projection.lastTerminal;
            contextUsage = projection.latestContextUsage;
          }
        } catch {
          // A corrupt/unavailable canonical session must never be fed back to
          // the model. The display cache is still useful as a read-only
          // fallback while the transport refuses that resume.
        }
        if (!isCurrentLoad()) return;
      }
      if (runtimeSessionId && runtimeSessionId !== conv.runtimeSessionId) {
        try {
          await repo.update(id, { runtimeSessionId });
        } catch {
          // Route lookup will recover the binding again on the next launch.
        }
        if (!isCurrentLoad()) return;
      }
      if (runtimeSessionId) {
        try {
          const latestPlan = await longTaskRepo.getLatestPlan({
            projectId: conv.projectId,
            sessionId: runtimeSessionId,
          });
          const manifestState = latestPlan
            ? await longTaskRepo.getChapterManifestState(
                {
                  projectId: conv.projectId,
                  sessionId: runtimeSessionId,
                },
                latestPlan.task.id,
              )
            : null;
          longTaskPlanState = summarizeLongTaskPlanForContinuation(
            runtimeSessionId,
            latestPlan,
            manifestState,
          );
        } catch {
          longTaskPlanState = null;
        }
        if (!isCurrentLoad()) return;
      }
      set((st) => ({
        runs: {
          ...st.runs,
          [id]: {
            projectId: conv.projectId,
            transcript: AgentChatTranscript.from(messages),
            runtimeSessionId,
            journalScope,
            controlStatus: null,
            pendingControl: null,
            lastTerminal,
            longTaskPlanState,
            contextUsage,
            automaticContinuation: createInactiveAgentAutomaticContinuation(),
          },
        },
      }));
    }
    if (!isCurrentLoad()) return;
    set({ activeConvId: id });
    const runtimeSessionId = get().runs[id]?.runtimeSessionId;
    if (runtimeSessionId) {
      const pending = await generalAgentTransport.listPendingControls({
        sessionId: runtimeSessionId,
      });
      if (!isCurrentLoad()) return;
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
    if (!isCurrentLoad()) return;
    useSettingsStore.getState().setLastAgentConv(boundProjectId, id);
  },

  deleteConversation: async (id) => {
    cancelAutomaticContinuationTimer(id);
    conversationLoadGuard.invalidate();
    if (get().runningTurns[id] && get().starting) {
      conversationStartGuard.invalidate();
    }
    // Abort only this conversation's turn; sibling conversations keep running.
    const deletingTurnId = get().runningTurns[id];
    if (deletingTurnId) {
      const deletingSessionId = get().runs[id]?.runtimeSessionId;
      void generalAgentTransport.abort({ turnId: deletingTurnId });
      journalConsumer.releaseTurn(deletingTurnId);
      if (deletingSessionId) {
        useAgentActivityStore
          .getState()
          .onTurnEnd({ sessionId: deletingSessionId, turnId: deletingTurnId });
      }
      set((state) => withoutRunningTurn(state, id, deletingTurnId) ?? state);
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
    conversationLoadGuard.invalidate();
    conversationStartGuard.invalidate();
    const pid = get().boundProjectId;
    if (!pid) return;
    for (const [convId, run] of Object.entries(get().runs)) {
      if (run.projectId === pid) cancelAutomaticContinuationTimer(convId);
    }
    // Abort every turn owned by this project, leaving other project caches alone.
    const clearingTurns = Object.entries(get().runningTurns).filter(
      ([convId]) => get().runs[convId]?.projectId === pid,
    );
    for (const [convId, turnId] of clearingTurns) {
      const sessionId = get().runs[convId]?.runtimeSessionId;
      void generalAgentTransport.abort({ turnId });
      journalConsumer.releaseTurn(turnId);
      if (sessionId) {
        useAgentActivityStore.getState().onTurnEnd({ sessionId, turnId });
      }
      set((state) => withoutRunningTurn(state, convId, turnId) ?? state);
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
      messages: run.transcript.toArray(),
      runtimeSessionId: run.runtimeSessionId,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort */
  }
  useAgentChatStore.getState().refreshList();
}

const AUTOMATIC_CONTINUATION_DELAY_MS = 600;

function cancelAutomaticContinuationTimer(convId: string): void {
  const timer = automaticContinuationTimers.get(convId);
  if (!timer) return;
  clearTimeout(timer);
  automaticContinuationTimers.delete(convId);
}

function pauseAutomaticContinuationForConversation(
  convId: string,
  reason: AgentAutomaticContinuationState['stopReason'],
): void {
  cancelAutomaticContinuationTimer(convId);
  useAgentChatStore.setState((state) => {
    const run = state.runs[convId];
    if (
      !run ||
      run.automaticContinuation.status === 'off' ||
      run.automaticContinuation.status === 'paused'
    ) {
      return state;
    }
    return {
      runs: {
        ...state.runs,
        [convId]: {
          ...run,
          automaticContinuation: {
            ...run.automaticContinuation,
            status: 'paused',
            stopReason: reason,
          },
        },
      },
    };
  });
}

function settleAutomaticContinuationAfterPlanRefresh(convId: string, terminalTurnId: string): void {
  const state = useAgentChatStore.getState();
  const run = state.runs[convId];
  if (
    !run ||
    run.lastTerminal?.turnId !== terminalTurnId ||
    run.automaticContinuation.status !== 'evaluating' ||
    run.automaticContinuation.terminalTurnId !== terminalTurnId
  ) {
    return;
  }
  const observedAutomatic = observeAgentAutomaticContinuationProgress(
    run.automaticContinuation,
    run.longTaskPlanState,
  );
  const decision = decideAgentAutomaticContinuation({
    automatic: observedAutomatic,
    plan: run.longTaskPlanState,
    terminalOutcome: run.lastTerminal.outcome,
    nowMs: Date.now(),
  });
  if (decision.kind === 'stop') {
    useAgentChatStore.setState((current) => {
      const currentRun = current.runs[convId];
      if (
        !currentRun ||
        currentRun.automaticContinuation.sequenceId !== run.automaticContinuation.sequenceId ||
        currentRun.automaticContinuation.terminalTurnId !== terminalTurnId
      ) {
        return current;
      }
      return {
        runs: {
          ...current.runs,
          [convId]: {
            ...currentRun,
            automaticContinuation: {
              ...observedAutomatic,
              status: decision.status,
              stopReason: decision.reason,
            },
          },
        },
      };
    });
    return;
  }

  if (state.boundProjectId !== run.projectId || state.activeConvId !== convId) {
    pauseAutomaticContinuationForConversation(convId, 'author_navigated');
    return;
  }
  if (state.prompt.trim()) {
    pauseAutomaticContinuationForConversation(convId, 'author_input_pending');
    return;
  }

  const sequenceId = run.automaticContinuation.sequenceId;
  const continuationPrompt =
    run.lastTerminal.outcome === 'budget_exceeded' &&
    run.longTaskPlanState?.status === 'none'
      ? BUDGET_CONTINUATION_PROMPT
      : ACTIVE_PLAN_CONTINUATION_PROMPT;
  useAgentChatStore.setState((current) => {
    const currentRun = current.runs[convId];
    if (
      !currentRun ||
      currentRun.automaticContinuation.sequenceId !== sequenceId ||
      currentRun.automaticContinuation.terminalTurnId !== terminalTurnId
    ) {
      return current;
    }
    return {
      runs: {
        ...current.runs,
        [convId]: {
          ...currentRun,
          automaticContinuation: {
            ...observedAutomatic,
            status: 'scheduled',
            stopReason: null,
          },
        },
      },
    };
  });
  cancelAutomaticContinuationTimer(convId);
  const timer = setTimeout(() => {
    automaticContinuationTimers.delete(convId);
    const current = useAgentChatStore.getState();
    const currentRun = current.runs[convId];
    if (
      !currentRun ||
      currentRun.automaticContinuation.sequenceId !== sequenceId ||
      currentRun.automaticContinuation.status !== 'scheduled' ||
      currentRun.automaticContinuation.terminalTurnId !== terminalTurnId
    ) {
      return;
    }
    if (current.boundProjectId !== currentRun.projectId || current.activeConvId !== convId) {
      pauseAutomaticContinuationForConversation(convId, 'author_navigated');
      return;
    }
    if (current.prompt.trim()) {
      pauseAutomaticContinuationForConversation(convId, 'author_input_pending');
      return;
    }
    if (current.starting || current.runningTurns[convId] || currentRun.pendingControl) {
      pauseAutomaticContinuationForConversation(convId, 'author_stopped');
      return;
    }
    void useAgentChatStore
      .getState()
      .send({
        origin: 'automatic_continuation',
        runtimePrompt: continuationPrompt,
      })
      .catch(() => pauseAutomaticContinuationForConversation(convId, 'start_failed'));
  }, AUTOMATIC_CONTINUATION_DELAY_MS);
  automaticContinuationTimers.set(convId, timer);
}

async function refreshLongTaskPlanState(
  convId: string,
  projectId: string,
  sessionId: string,
  terminalTurnId: string,
): Promise<void> {
  let planState: RunLongTaskPlanState | null = null;
  try {
    const latestPlan = await longTaskRepo.getLatestPlan({
      projectId,
      sessionId,
    });
    const manifestState = latestPlan
      ? await longTaskRepo.getChapterManifestState({ projectId, sessionId }, latestPlan.task.id)
      : null;
    planState = summarizeLongTaskPlanForContinuation(sessionId, latestPlan, manifestState);
  } catch {
    // Continuation authority is fail-closed when the durable plan cannot be read.
  }
  if (journalConsumer.isDisposed()) return;
  useAgentChatStore.setState((state) => {
    const run = state.runs[convId];
    if (!run || run.runtimeSessionId !== sessionId || run.lastTerminal?.turnId !== terminalTurnId) {
      return state;
    }
    return {
      runs: {
        ...state.runs,
        [convId]: {
          ...run,
          longTaskPlanState: planState,
        },
      },
    };
  });
  settleAutomaticContinuationAfterPlanRefresh(convId, terminalTurnId);
}

function appendRunError(convId: string, message: string): void {
  useAgentChatStore.setState((state) => {
    const run = state.runs[convId];
    if (!run) return state;
    return {
      runs: {
        ...state.runs,
        [convId]: {
          ...run,
          transcript: finalizeAgentChatTranscript(run.transcript).append({ kind: 'error', text: message }),
        },
      },
    };
  });
}

// One app owner; panel remounts only ensure the connection exists. Ports keep
// persistence, activity and automatic-plan effects at the composition boundary.
const journalConsumer = createAgentChatJournalConsumer({
  read: () => useAgentChatStore.getState(),
  updateRun: (conversationId, project) => useAgentChatStore.setState(state => {
    const run = state.runs[conversationId];
    if (!run) return state;
    const next = project(run);
    return next === run ? state : { runs: { ...state.runs, [conversationId]: next } };
  }),
  persistConversation: conversationId => { void persistConv(conversationId); },
  refreshPlan: (conversationId, projectId, sessionId, turnId) => { void refreshLongTaskPlanState(conversationId, projectId, sessionId, turnId); },
  finishTurn: (conversationId, turnId) => useAgentChatStore.setState(state => withoutRunningTurn(state, conversationId, turnId) ?? state),
  activity: () => useAgentActivityStore.getState(),
  subscribeJournal: callback => generalAgentTransport.subscribeJournal(callback),
  subscribeChanges: callback => {
    events.on('agent:conversations-changed', callback);
    return () => events.off('agent:conversations-changed', callback);
  },
  conversationsChanged: ({ projectId, conversationIds }) => {
    const state = useAgentChatStore.getState();
    if (state.boundProjectId !== projectId) return;
    state.refreshList();
    const activeId = state.activeConvId;
    // Keep live runs intact. Idle histories may have acquired a remote tail.
    useAgentChatStore.setState((current) => ({ runs: Object.fromEntries(Object.entries(current.runs).filter(([id, run]) => !conversationIds.includes(id) || Boolean(current.runningTurns[id]) || ['armed', 'evaluating', 'scheduled'].includes(run.automaticContinuation.status))) }));
    if (activeId && conversationIds.includes(activeId) && !useAgentChatStore.getState().runs[activeId]) void state.loadConversation(activeId);
  },
});

function ensureSubscription(): void { journalConsumer.ensureConnected(); }

if (import.meta.hot) import.meta.hot.dispose(() => {
  journalConsumer.dispose();
  conversationLoadGuard.invalidate(); conversationStartGuard.invalidate();
  for (const conversationId of automaticContinuationTimers.keys()) cancelAutomaticContinuationTimer(conversationId);
});
