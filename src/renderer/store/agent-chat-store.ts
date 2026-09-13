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
import { useAgentEditStore } from './agent-edit-store';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { AgentConversationLoadGuard, createAgentConversationListController } from '../lib/agent/runtime/chat-conversation-navigation';
import { createAgentConversationRemovalOwner } from '../lib/agent/runtime/chat-conversation-removal';
import type { AgentConversationRemovalReceipt } from '../sqlite-repo/agent-conversation-repo';
import { hydrateAgentConversationRun } from '../lib/agent/runtime/chat-conversation-hydration';
import { createAgentChatStartOwner } from '../lib/agent/runtime/chat-start-owner';
import { buildAgentChatRevertNote, prepareAgentChatMemories } from '../lib/agent/runtime/chat-send-preparation';
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
import type { AgentChatRunState as RunState } from '../lib/agent/runtime/chat-run-projection';
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
  deleteConversation: (id: string) => Promise<AgentConversationRemovalReceipt[] | null>;
  /** Delete the explicit or bound project; publish only the committed receipt. */
  clearConversations: (projectId?: string) => Promise<AgentConversationRemovalReceipt[] | null>;
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

export { AgentConversationLoadGuard, type AgentConversationLoadToken } from '../lib/agent/runtime/chat-conversation-navigation';

const conversationLoadGuard = new AgentConversationLoadGuard();
const conversationRemovals = createAgentConversationRemovalOwner();
const conversationStartOwner = createAgentChatStartOwner(value => {
  useAgentChatStore.setState(state => state.starting === value ? state : { starting: value });
});

const conversationLists = createAgentConversationListController({
  read: () => { const state = useAgentChatStore.getState(); return { projectId: state.boundProjectId, activeConvId: state.activeConvId, prompt: state.prompt, starting: state.starting }; },
  list: projectId => repo.listByProject(projectId),
  publish: convList => useAgentChatStore.setState({ convList }),
  lastConversation: projectId => useSettingsStore.getState().lastAgentConvByProject[projectId],
  restore: (id, current) => openAgentConversation(id, current),
});

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

  setPrompt: (p) => { if (p !== get().prompt) conversationLists.cancelRestore(); set({ prompt: p }); },

  refreshList: () => conversationLists.refresh(),

  bindProject: (projectId, options) => {
    ensureSubscription();
    if (get().boundProjectId === projectId) {
      // Same project (e.g. a remount) — keep the live transcript, just refresh.
      get().refreshList();
      return;
    }
    conversationLoadGuard.invalidate();
    const leavingProjectId = get().boundProjectId;
    if (leavingProjectId) conversationStartOwner.cancelProject(leavingProjectId);
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
    conversationLists.bind(projectId, options?.restoreLastConversation !== false);
    set({ boundProjectId: projectId, activeConvId: null, prompt: '', convList: [] });
    conversationLists.refresh();
  },

  send: async (options) => {
    conversationLists.cancelRestore();
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
    const start = conversationStartOwner.begin(s.boundProjectId, s.activeConvId);
    if (!start) return;
    const isCurrentStart = (): boolean => start.isCurrent(get().boundProjectId);
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
      if (!(await conversationRemovals.wait(s.boundProjectId, s.activeConvId)) || !isCurrentStart()) return;
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
        if (isCurrentStart()) appendRunError(convId, error instanceof Error ? error.message : String(error));
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
      start.prepareTurn(cid, () => {
        journalConsumer.releaseTurn(turnId);
        set((state) => withoutRunningTurn(state, cid, turnId) ?? state);
      });
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
      if (!isCurrentStart()) return;
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
      const prepared = await prepareAgentChatMemories(projectId, isCurrentStart);
      if (!prepared || !isCurrentStart() || !start.submit()) return;

      // Drain rejected edits only once all cancellable preflight reads are done.
      // The visible transcript keeps the original user text; only the provider
      // prompt receives this system context.
      const reverts = useAgentEditStore
        .getState()
        .drainReverts(projectId, run.runtimeSessionId);
      // Durable write-review decisions are first-class pinned context rows in
      // the product composition. Do not duplicate them into every user prompt;
      // that legacy path grew long tasks quadratically and blurred authorship.
      const promptNotes = reverts.length ? [buildAgentChatRevertNote(reverts, entityDisplayName)] : [];
      const visibleContextNote = agentTurnContextPrompt(turnContext);
      if (visibleContextNote) promptNotes.push(visibleContextNote);
      const promptToSend = promptNotes.length ? `${promptNotes.join('\n\n')}\n\n${text}` : text;
      const r = await (async () => generalAgentTransport.start({
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
          ...prepared,
          turnId,
        }))()
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'AGENT_RUNTIME_START_FAILED',
          error: error instanceof Error ? error.message : 'Agent Runtime failed to start.',
        }));
      // Once submitted, result ownership is the captured turn, independent of
      // which conversation is now visible. Navigation preserves background work.
      if (r.ok && start.shouldAbort()) void generalAgentTransport.abort({ turnId });
      if (get().runningTurns[cid] !== turnId) return;
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
            ...(cleared ?? {}),
          };
        });
      }
    } finally {
      start.finish();
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
    if (convId) {
      conversationStartOwner.cancelConversation(convId);
      pauseAutomaticContinuationForConversation(convId, 'author_stopped');
    } else conversationStartOwner.cancelActive();
    const turnId = convId ? s.runningTurns[convId] : undefined;
    if (turnId) void generalAgentTransport.abort({ turnId });
  },

  newConversation: () => {
    conversationLists.cancelRestore();
    const activeConvId = get().activeConvId;
    if (activeConvId) {
      pauseAutomaticContinuationForConversation(activeConvId, 'author_navigated');
    }
    conversationLoadGuard.invalidate();
    conversationStartOwner.invalidate();
    const pid = get().boundProjectId;
    if (pid) useSettingsStore.getState().clearLastAgentConv(pid);
    // Switch the view to a fresh, empty chat. A background turn (if any) keeps
    // running in its own conversation — we don't abort it here.
    set({ activeConvId: null, prompt: '' });
  },

  loadConversation: (id) => {
    conversationLists.cancelRestore();
    return openAgentConversation(id);
  },

  deleteConversation: async (id) => {
    const finish = conversationRemovals.begin({ conversationId: id });
    if (!finish) return null;
    try {
      stopConversationForRemoval(id);
      const receipt = await repo.softDelete(id, new Date().toISOString());
      // A successful missing-row delete also evicts this explicitly targeted
      // cache; an unsuccessful database write must retain it for recovery.
      removeCommittedConversations([id]);
      return receipt;
    } catch {
      return null;
    } finally { finish(); get().refreshList(); }
  },

  clearConversations: async (projectId) => {
    const pid = projectId ?? get().boundProjectId;
    if (!pid) return null;
    const finish = conversationRemovals.begin({ projectId: pid });
    if (!finish) return null;
    try {
      if (get().boundProjectId === pid) conversationLists.cancelRestore();
      conversationStartOwner.cancelProject(pid);
      for (const [id, run] of Object.entries(get().runs)) if (run.projectId === pid) stopConversationForRemoval(id);
      const receipt = await repo.softDeleteAllByProject(pid, new Date().toISOString());
      removeCommittedConversations(receipt.map(row => row.id));
      return receipt;
    } catch {
      return null;
    } finally { finish(); get().refreshList(); }
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

/** Runtime cleanup is keyed by the removed conversation, never the visible view. */
function stopConversationForRemoval(id: string): void {
  pauseAutomaticContinuationForConversation(id, 'author_stopped');
  conversationStartOwner.cancelConversation(id);
  const state = useAgentChatStore.getState(); const turnId = state.runningTurns[id];
  if (!turnId) return;
  const sessionId = state.runs[id]?.runtimeSessionId;
  try { void generalAgentTransport.abort({ turnId }).catch(() => undefined); } catch { /* Removal still uses the durable receipt if transport cancellation is unavailable. */ }
  journalConsumer.releaseTurn(turnId);
  if (sessionId) useAgentActivityStore.getState().onTurnEnd({ sessionId, turnId });
  useAgentChatStore.setState(current => withoutRunningTurn(current, id, turnId) ?? current);
}

function removeCommittedConversations(ids: readonly string[]): void {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  for (const id of removed) stopConversationForRemoval(id);
  const settings = useSettingsStore.getState();
  for (const [pid, id] of Object.entries(settings.lastAgentConvByProject)) if (removed.has(id)) settings.clearLastAgentConv(pid);
  useAgentChatStore.setState(state => {
    const hasRun = ids.some(id => id in state.runs);
    const hasActive = state.activeConvId !== null && removed.has(state.activeConvId);
    const hasList = state.convList.some(row => removed.has(row.id));
    if (!hasRun && !hasActive && !hasList) return state;
    return {
      runs: hasRun ? Object.fromEntries(Object.entries(state.runs).filter(([id]) => !removed.has(id))) : state.runs,
      activeConvId: hasActive ? null : state.activeConvId,
      convList: hasList ? state.convList.filter(row => !removed.has(row.id)) : state.convList,
    };
  });
}

async function openAgentConversation(id: string, isCurrentRestore: () => boolean = () => true): Promise<void> {
  if (!isCurrentRestore()) return;
  const get = useAgentChatStore.getState; const set = useAgentChatStore.setState;
  const boundProjectId = get().boundProjectId;
  if (!boundProjectId) return;
  const previousActiveConvId = get().activeConvId;
  if (previousActiveConvId && previousActiveConvId !== id) {
    pauseAutomaticContinuationForConversation(previousActiveConvId, 'author_navigated');
  }
  conversationStartOwner.invalidate();
  let visible = false;
  const loadToken = conversationLoadGuard.begin(boundProjectId);
  const isCurrentLoad = (): boolean =>
    conversationLoadGuard.isCurrent(loadToken, get().boundProjectId) && (visible || isCurrentRestore());
  if (conversationRemovals.hasPending(boundProjectId, id) && !(await conversationRemovals.wait(boundProjectId, id))) return;
  if (!isCurrentLoad()) return;
  const removalRead = conversationRemovals.read(boundProjectId, id);
  const isCurrentRead = () => isCurrentLoad() && removalRead.isCurrent();
  try {
    // Don't clobber a conversation that's live in memory (it may be running in
    // the background) with a stale DB snapshot — only hydrate if not loaded.
    const loadedRun = get().runs[id];
    if (loadedRun && loadedRun.projectId !== boundProjectId) return;
    if (!loadedRun) {
      const run = await hydrateAgentConversationRun(id, boundProjectId, isCurrentRead);
      if (!isCurrentRead()) return;
      if (!run) {
        if (get().activeConvId === id) set({ activeConvId: null });
        if (useSettingsStore.getState().lastAgentConvByProject[boundProjectId] === id) useSettingsStore.getState().clearLastAgentConv(boundProjectId);
        return;
      }
      set((state) => ({ runs: { ...state.runs, [id]: run } }));
    }
    if (!isCurrentRead()) return;
    visible = true;
    set({ activeConvId: id });
    if (!isCurrentRead()) return;
    const runtimeSessionId = get().runs[id]?.runtimeSessionId;
    if (runtimeSessionId) {
      const pending = await generalAgentTransport.listPendingControls({
        sessionId: runtimeSessionId,
      });
      if (!isCurrentRead()) return;
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
    if (!isCurrentRead()) return;
    useSettingsStore.getState().setLastAgentConv(boundProjectId, id);
  } finally { removalRead.finish(); }
}

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
  conversationRemovals.dispose(); conversationLists.dispose(); conversationLoadGuard.invalidate(); conversationStartOwner.dispose();
  for (const conversationId of automaticContinuationTimers.keys()) cancelAutomaticContinuationTimer(conversationId);
});
