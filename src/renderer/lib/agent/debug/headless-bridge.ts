import { getActiveAgentToolContext } from '../tool-handlers';
import { generalAgentTransport } from '../transport';
import type { AgentPermissionResolutionInput } from '../protocol';
import type {
  AgentContextUsageSnapshot,
  AgentRuntimeJournalEntry,
  AgentRuntimeOutcome,
} from '../runtime/types';
import { useAgentChatStore } from '../../../store/agent-chat-store';
import { useSettingsStore } from '../../../store/settings-store';
import {
  acceptDriftingAgentWriteReview,
  acceptDriftingAgentWriteReviewBlock,
  rejectDriftingAgentWriteReview,
  rejectDriftingAgentWriteReviewBlock,
} from '../useDriftingAgentRuntime';

const EVENT_BATCH_DELAY_MS = 24;
const RETRY_DELAY_MS = 1_000;
const TERMINAL_GRACE_MS = 5_000;
const STORE_RELEASE_GRACE_MS = 2_000;
const CONVERSATION_LOAD_GRACE_MS = 3_000;

type PermissionMode = 'manual' | 'allow_once' | 'deny';

interface DebugTurnRequest {
  kind: 'turn';
  requestId: string;
  projectId: string;
  prompt: string;
  newConversation: boolean;
  conversationId?: string;
  timeoutMs: number;
  permissionMode: PermissionMode;
  userInputs: string[];
  autoContinue: boolean;
  editMode?: 'auto' | 'approve';
}

interface DebugReviewRequest {
  kind: 'review';
  requestId: string;
  projectId: string;
  reviewId: string;
  blockId?: string;
  decision: 'accept' | 'reject';
  note?: string;
  timeoutMs: number;
}

type DebugRequest = DebugTurnRequest | DebugReviewRequest;

interface InstallHeadlessBridgeOptions {
  projectId: string;
}

interface DebugBridgePayload {
  type: string;
  requestId: string;
  [key: string]: unknown;
}

interface PendingDebugBridgePayload {
  type: string;
  [key: string]: unknown;
}

class DebugEventBatcher {
  private queued: DebugBridgePayload[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delivery = Promise.resolve();
  private deliveryError: Error | null = null;

  constructor(
    private readonly baseUrl: URL,
    private readonly requestId: string,
  ) {}

  emit(payload: PendingDebugBridgePayload): void {
    this.queued.push({ ...payload, requestId: this.requestId });
    if (
      this.queued.length >= 32 ||
      payload.type === 'bridge_completed' ||
      payload.type === 'bridge_failed'
    ) {
      this.scheduleFlush(0);
      return;
    }
    this.scheduleFlush(EVENT_BATCH_DELAY_MS);
  }

  async finish(): Promise<void> {
    await this.flush();
    await this.delivery;
    if (this.deliveryError) throw this.deliveryError;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) {
      if (delayMs !== 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queued.length === 0) {
      await this.delivery;
      return;
    }
    const events = this.queued;
    this.queued = [];
    this.delivery = this.delivery.then(async () => {
      try {
        const response = await fetch(new URL('/events', this.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: this.requestId, events }),
        });
        if (!response.ok) {
          throw new Error(`Debug broker rejected events with HTTP ${response.status}`);
        }
      } catch (error) {
        this.deliveryError ??= error instanceof Error ? error : new Error(String(error));
      }
    });
    await this.delivery;
  }
}

let activeBridge: { projectId: string; controller: AbortController } | null = null;

export function installAgentHeadlessDebugBridge(options: InstallHeadlessBridgeOptions): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  const configured = import.meta.env.VITE_DRIFTING_AGENT_DEBUG_URL?.trim();
  if (!configured) return () => undefined;
  const baseUrl = requireLoopbackHttpUrl(configured);

  activeBridge?.controller.abort('Agent debug bridge replaced');
  const controller = new AbortController();
  const installed = { projectId: options.projectId, controller };
  activeBridge = installed;
  void pollForTurns(baseUrl, options.projectId, controller.signal);

  return () => {
    if (activeBridge !== installed) return;
    activeBridge = null;
    controller.abort('Agent debug bridge stopped');
  };
}

function requireLoopbackHttpUrl(value: string): URL {
  const url = new URL(value);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error('VITE_DRIFTING_AGENT_DEBUG_URL must be a loopback http URL');
  }
  return url;
}

async function pollForTurns(baseUrl: URL, projectId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await consumeDebugRequestStream(baseUrl, projectId, signal);
    } catch (error) {
      if (signal.aborted) return;
      console.warn('[agent-debug] bridge poll failed:', error);
      await delay(RETRY_DELAY_MS, signal).catch(() => undefined);
    }
  }
}

async function consumeDebugRequestStream(
  baseUrl: URL,
  projectId: string,
  signal: AbortSignal,
): Promise<void> {
  const streamUrl = new URL('/stream', baseUrl);
  streamUrl.searchParams.set('projectId', projectId);
  const response = await fetch(streamUrl, { cache: 'no-store', signal });
  if (!response.ok || !response.body) {
    throw new Error(`Agent debug broker returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          const payload = JSON.parse(line) as unknown;
          if (isRecord(payload) && payload.type === 'request') {
            const request = parseDebugRequest(payload.request, projectId);
            if (request.kind === 'turn') {
              await executeDebugTurn(baseUrl, request, signal);
            } else {
              await executeDebugReview(baseUrl, request, signal);
            }
          }
        }
        newline = buffered.indexOf('\n');
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function parseDebugRequest(value: unknown, projectId: string): DebugRequest {
  if (!isRecord(value)) throw new Error('Agent debug broker returned an invalid request');
  if (value.projectId !== projectId) throw new Error('Agent debug request project does not match');
  if (typeof value.requestId !== 'string') {
    throw new Error('Agent debug request is missing requestId');
  }
  if (value.kind === 'review') {
    if (
      typeof value.reviewId !== 'string' ||
      (value.decision !== 'accept' && value.decision !== 'reject')
    ) {
      throw new Error('Agent debug review request is invalid');
    }
    return {
      kind: 'review',
      requestId: value.requestId,
      projectId,
      reviewId: value.reviewId,
      ...(typeof value.blockId === 'string' && value.blockId.trim()
        ? { blockId: value.blockId.trim() }
        : {}),
      decision: value.decision,
      ...(typeof value.note === 'string' ? { note: value.note } : {}),
      timeoutMs: 120_000,
    };
  }
  if (value.kind !== 'turn' || typeof value.prompt !== 'string') {
    throw new Error('Agent debug turn request is missing kind or prompt');
  }
  const permissionMode = value.permissionMode;
  if (permissionMode !== 'manual' && permissionMode !== 'allow_once' && permissionMode !== 'deny') {
    throw new Error('Agent debug request has an invalid permissionMode');
  }
  return {
    kind: 'turn',
    requestId: value.requestId,
    projectId,
    prompt: value.prompt,
    newConversation: value.newConversation !== false,
    ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
    timeoutMs:
      typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs)
        ? value.timeoutMs
        : 600_000,
    permissionMode,
    autoContinue: value.autoContinue === true,
    userInputs: Array.isArray(value.userInputs)
      ? value.userInputs.filter((item): item is string => typeof item === 'string')
      : [],
    ...(value.editMode === 'auto' || value.editMode === 'approve'
      ? { editMode: value.editMode }
      : {}),
  };
}

async function executeDebugReview(
  baseUrl: URL,
  request: DebugReviewRequest,
  signal: AbortSignal,
): Promise<void> {
  const emitter = new DebugEventBatcher(baseUrl, request.requestId);
  emitter.emit({
    type: 'bridge_started',
    projectId: request.projectId,
    operation: 'review',
  });
  try {
    if (signal.aborted) throw new DOMException('Debug bridge stopped', 'AbortError');
    const context = getActiveAgentToolContext();
    if (!context || context.projectId !== request.projectId) {
      throw new Error('The requested project does not have an active renderer tool context');
    }
    if (useAgentChatStore.getState().runningConvId) {
      throw new Error('A review cannot settle while an Agent turn is running');
    }
    const note = request.note ? { note: request.note } : undefined;
    const result = request.blockId
      ? request.decision === 'accept'
        ? await acceptDriftingAgentWriteReviewBlock(
            request.reviewId,
            request.blockId,
            note,
          )
        : await rejectDriftingAgentWriteReviewBlock(
            request.reviewId,
            request.blockId,
            note,
            signal,
          )
      : request.decision === 'accept'
        ? await acceptDriftingAgentWriteReview(request.reviewId, note)
        : await rejectDriftingAgentWriteReview(request.reviewId, note, signal);
    const blockResult = request.blockId
      ? (result as Awaited<ReturnType<typeof acceptDriftingAgentWriteReviewBlock>>)
      : null;
    emitter.emit({
      type: 'review_result',
      result: {
        review: {
          id: result.review.id,
          status: result.review.status,
          effectId: result.review.effectId,
          revertEffect: result.review.revertEffect,
          errorCode: result.review.errorCode,
          errorMessage: result.review.errorMessage,
          acceptedAt: result.review.acceptedAt,
          rejectedAt: result.review.rejectedAt,
          settledAt: result.review.settledAt,
        },
        effect: {
          id: result.effect.id,
          phase: result.effect.phase,
          toolName: result.effect.toolName,
        },
        ...(blockResult
          ? {
              block: {
                reviewId: blockResult.block.reviewId,
                blockId: blockResult.block.blockId,
                ordinal: blockResult.block.ordinal,
                status: blockResult.block.status,
                decisionNote: blockResult.block.decisionNote,
                settledAt: blockResult.block.settledAt,
                errorCode: blockResult.block.errorCode,
                errorMessage: blockResult.block.errorMessage,
              },
            }
          : {}),
      },
    });
    emitter.emit({
      type: 'bridge_completed',
      projectId: request.projectId,
      operation: 'review',
      reviewId: result.review.id,
      ...(request.blockId ? { blockId: request.blockId } : {}),
      status: result.review.status,
    });
    await emitter.finish();
  } catch (error) {
    emitter.emit({
      type: 'bridge_failed',
      projectId: request.projectId,
      operation: 'review',
      error: error instanceof Error ? error.message : String(error),
    });
    await emitter.finish().catch(() => undefined);
  }
}

async function executeDebugTurn(
  baseUrl: URL,
  request: DebugTurnRequest,
  bridgeSignal: AbortSignal,
): Promise<void> {
  const emitter = new DebugEventBatcher(baseUrl, request.requestId);
  emitter.emit({ type: 'bridge_started', projectId: request.projectId });
  const deadlineAt = Date.now() + request.timeoutMs;
  const leaseController = new AbortController();
  const stopLeaseOnBridgeAbort = () => leaseController.abort('Debug bridge stopped');
  bridgeSignal.addEventListener('abort', stopLeaseOnBridgeAbort, { once: true });
  let leaseCancellationStarted = false;
  const leaseWatcher = watchDebugLease(baseUrl, request, leaseController.signal, async (reason) => {
    if (leaseCancellationStarted) return;
    leaseCancellationStarted = true;
    emitter.emit({ type: 'bridge_stage', stage: 'cancelling_turn', reason });
    // Invalidate startup work that may still be awaiting renderer storage,
    // then cancel a provider/tool turn if it already entered the transport.
    useAgentChatStore.getState().newConversation();
    await generalAgentTransport.abort();
  }).catch((error) => {
    if (!leaseController.signal.aborted) {
      console.warn('[agent-debug] request lease failed:', error);
    }
  });
  let journalSubscription: (() => void) | null = null;
  const previousEditMode = useSettingsStore.getState().agentEditMode;
  if (request.editMode) {
    useSettingsStore.getState().setAgentEditMode(request.editMode);
  }
  try {
    // Flush the handshake before entering any renderer/database preflight so a
    // stuck startup is distinguishable from a disconnected bridge.
    await emitter.finish();
    const context = getActiveAgentToolContext();
    if (!context || context.projectId !== request.projectId) {
      throw new Error('The requested project does not have an active renderer tool context');
    }
    const initial = useAgentChatStore.getState();
    if (initial.starting || initial.runningConvId) {
      throw new Error('The App already has an Agent turn in progress');
    }

    initial.bindProject(request.projectId);
    if (request.conversationId) {
      await loadDebugConversation(request.conversationId, deadlineAt, bridgeSignal);
    } else if (request.newConversation) {
      useAgentChatStore.getState().newConversation();
    }

    let firstTurnId: string | null = null;
    let latestTurnId: string | null = null;
    let conversationId: string | null = request.conversationId ?? null;
    let sessionId: string | null = null;
    let outcome: AgentRuntimeOutcome | null = null;
    let assistantText = '';
    let thinkingText = '';
    let latestContext: AgentContextUsageSnapshot | null = null;
    const toolCalls: Array<{ callId: string; name: string; arguments: Record<string, unknown> }> =
      [];
    const toolResults: Array<{ callId: string; name: string; ok: boolean; errorCode?: string }> =
      [];
    const queuedUserInputs = [...request.userInputs];
    const turnIds: string[] = [];
    const observedTurnIds = new Set<string>();
    let resolveTerminal!: (entry: AgentRuntimeJournalEntry) => void;
    const terminal = new Promise<AgentRuntimeJournalEntry>((resolve) => {
      resolveTerminal = resolve;
    });

    const subscription = generalAgentTransport.subscribeJournal((entry) => {
      if (entry.route.kind !== 'chat' || entry.route.projectId !== request.projectId) return;
      const routedConversationId = entry.route.conversationId;
      if (!routedConversationId) return;
      if (!firstTurnId) {
        const runningTurnId = useAgentChatStore.getState().runningTurnId;
        if (entry.event.type !== 'turn_started' || entry.turnId !== runningTurnId) return;
        if (conversationId && routedConversationId !== conversationId) return;
        firstTurnId = entry.turnId;
        conversationId = routedConversationId;
      }
      if (routedConversationId !== conversationId) return;
      if (entry.event.type === 'turn_started') {
        const runningTurnId = useAgentChatStore.getState().runningTurnId;
        if (entry.turnId !== runningTurnId) return;
        if (!observedTurnIds.has(entry.turnId)) {
          if (assistantText) assistantText += '\n\n';
          if (thinkingText) thinkingText += '\n\n';
          observedTurnIds.add(entry.turnId);
          turnIds.push(entry.turnId);
        }
        latestTurnId = entry.turnId;
      }
      if (!observedTurnIds.has(entry.turnId)) return;
      sessionId = entry.sessionId;
      emitter.emit({ type: 'journal', entry });
      const event = entry.event;
      if (event.type === 'text_delta') assistantText += event.text;
      else if (event.type === 'thinking_delta') thinkingText += event.text;
      else if (event.type === 'context_planned') latestContext = event.snapshot;
      else if (event.type === 'tool_call_ready') {
        toolCalls.push({ callId: event.callId, name: event.name, arguments: event.arguments });
      } else if (event.type === 'tool_result') {
        toolResults.push({
          callId: event.callId,
          name: event.name,
          ok: event.ok,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        });
      } else if (event.type === 'permission_requested' && request.permissionMode !== 'manual') {
        const resolution: AgentPermissionResolutionInput = {
          requestId: event.request.requestId,
          sessionId: event.request.sessionId,
          turnId: event.request.turnId,
          callId: event.request.callId,
          argumentsHash: event.request.argumentsHash,
          revision: event.request.revision,
          decision: request.permissionMode === 'allow_once' ? 'allow' : 'deny',
          scope: 'once',
          reason: 'Resolved by the local Agent headless debug bridge',
        };
        void generalAgentTransport.resolvePermission(resolution).then((result) => {
          emitter.emit({ type: 'control_resolution', control: 'permission', result });
        });
      } else if (event.type === 'user_input_requested' && queuedUserInputs.length > 0) {
        const text = queuedUserInputs.shift()!;
        void generalAgentTransport
          .submitUserInput({
            requestId: event.request.requestId,
            sessionId: event.request.sessionId,
            turnId: event.request.turnId,
            callId: event.request.callId,
            text,
          })
          .then((result) => {
            emitter.emit({ type: 'control_resolution', control: 'user_input', result });
          });
      } else if (event.type === 'turn_finished') {
        outcome = event.outcome;
        resolveTerminal(entry);
      }
    });
    if (!subscription.ok) throw new Error(subscription.error);
    journalSubscription = subscription.value;

    useAgentChatStore.getState().setPrompt(request.prompt);
    emitter.emit({ type: 'bridge_stage', stage: 'starting_turn' });
    await emitter.finish();
    await waitForDebugOperation(
      useAgentChatStore
        .getState()
        .send({ origin: request.autoContinue ? 'headless_auto' : 'headless_once' }),
      remainingDebugTime(deadlineAt, request.timeoutMs),
      bridgeSignal,
      'Agent debug turn startup',
    ).catch(async (error) => {
      // Invalidate any store preflight that later resumes after this bridge has
      // already failed, then cancel a transport turn if startup reached it.
      useAgentChatStore.getState().newConversation();
      await generalAgentTransport.abort();
      throw error;
    });
    emitter.emit({ type: 'bridge_stage', stage: 'turn_started' });
    const startedState = useAgentChatStore.getState();
    conversationId ??= startedState.runningConvId ?? startedState.activeConvId;
    if (!firstTurnId || !conversationId) {
      throw new Error('Agent turn failed before the canonical turn_started event');
    }

    const terminalEntry = await waitForTerminal(
      terminal,
      remainingDebugTime(deadlineAt, request.timeoutMs),
      bridgeSignal,
    ).catch(async (error) => {
      await generalAgentTransport.abort();
      return waitForTerminal(terminal, TERMINAL_GRACE_MS, bridgeSignal).catch(() => {
        throw error;
      });
    });
    // `turn_finished` is the canonical terminal signal, but the chat store's
    // journal subscriber still has to clear its running pointers. Do not tell
    // the broker that the renderer is reusable until that synchronous fold has
    // become observable; otherwise an immediate next request can race the UI
    // projection and be rejected as an overlapping turn.
    await waitForChatStoreTurnRelease(firstTurnId, bridgeSignal);
    if (request.autoContinue) {
      await waitForAutomaticContinuationSequence(
        conversationId,
        deadlineAt,
        request.timeoutMs,
        bridgeSignal,
      );
    }
    sessionId ??= terminalEntry.sessionId;
    const automaticContinuation =
      useAgentChatStore.getState().runs[conversationId]?.automaticContinuation ?? null;
    emitter.emit({
      type: 'bridge_completed',
      projectId: request.projectId,
      conversationId,
      turnId: latestTurnId ?? firstTurnId,
      turnIds,
      sessionId,
      outcome: outcome ?? 'failed',
      automaticContinuation,
      assistantText,
      thinkingText,
      context: latestContext,
      toolCalls,
      toolResults,
    });
    await emitter.finish();
  } catch (error) {
    emitter.emit({
      type: 'bridge_failed',
      projectId: request.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    await emitter.finish().catch((deliveryError) => {
      console.warn('[agent-debug] failed to report bridge error:', deliveryError);
    });
  } finally {
    leaseController.abort('Debug request finished');
    bridgeSignal.removeEventListener('abort', stopLeaseOnBridgeAbort);
    await leaseWatcher;
    journalSubscription?.();
    if (request.editMode && useSettingsStore.getState().agentEditMode === request.editMode) {
      useSettingsStore.getState().setAgentEditMode(previousEditMode);
    }
  }
}

/**
 * App boot restores the last-open conversation asynchronously after binding a
 * project. A headless resume can arrive during that restore, and the store's
 * stale-load guard may correctly discard either racing hydration. Retry the
 * requested id for a short bounded grace period instead of reporting a false
 * "not found" while startup settles.
 */
async function loadDebugConversation(
  conversationId: string,
  turnDeadlineAt: number,
  signal: AbortSignal,
): Promise<void> {
  const loadDeadlineAt = Math.min(turnDeadlineAt, Date.now() + CONVERSATION_LOAD_GRACE_MS);
  while (!signal.aborted && Date.now() < loadDeadlineAt) {
    await waitForDebugOperation(
      useAgentChatStore.getState().loadConversation(conversationId),
      Math.max(1, loadDeadlineAt - Date.now()),
      signal,
      'Agent debug conversation load',
    );
    if (useAgentChatStore.getState().activeConvId === conversationId) return;
    await delay(50, signal);
  }
  if (signal.aborted) {
    throw new DOMException('Debug bridge stopped', 'AbortError');
  }
  throw new Error(`Agent conversation ${conversationId} could not be loaded`);
}

async function watchDebugLease(
  baseUrl: URL,
  request: DebugTurnRequest,
  signal: AbortSignal,
  onCancel: (reason: string) => Promise<void>,
): Promise<void> {
  const watchUrl = new URL('/watch', baseUrl);
  watchUrl.searchParams.set('requestId', request.requestId);
  watchUrl.searchParams.set('projectId', request.projectId);
  const response = await fetch(watchUrl, { cache: 'no-store', signal });
  if (!response.ok || !response.body) {
    throw new Error(`Agent debug lease returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          const lease = JSON.parse(line) as unknown;
          if (
            isRecord(lease) &&
            lease.cancelRequested === true &&
            typeof lease.reason === 'string'
          ) {
            await onCancel(lease.reason);
          }
        }
        newline = buffered.indexOf('\n');
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function remainingDebugTime(deadlineAt: number, configuredTimeoutMs: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error(`Agent debug turn exceeded ${configuredTimeoutMs} ms`);
  }
  return remaining;
}

async function waitForDebugOperation<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    throw new DOMException('Debug bridge stopped', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException('Debug bridge stopped', 'AbortError')));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`))),
      timeoutMs,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function waitForChatStoreTurnRelease(turnId: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + STORE_RELEASE_GRACE_MS;
  while (!signal.aborted) {
    const state = useAgentChatStore.getState();
    if (state.runningTurnId !== turnId && !state.starting) return;
    if (Date.now() >= deadline) {
      throw new Error(`Agent chat store did not release terminal turn ${turnId}`);
    }
    await delay(0, signal);
  }
  throw new DOMException('Debug bridge stopped', 'AbortError');
}

/**
 * A headless auto-continuation request owns the renderer until the bounded
 * sequence reaches a stable pause/off state. Journal events remain subscribed
 * during this wait, so every automatically started slice is observable by the
 * terminal client rather than escaping as background work.
 */
async function waitForAutomaticContinuationSequence(
  conversationId: string,
  deadlineAt: number,
  configuredTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    remainingDebugTime(deadlineAt, configuredTimeoutMs);
    const state = useAgentChatStore.getState();
    const run = state.runs[conversationId];
    if (!run) throw new Error(`Agent conversation ${conversationId} disappeared during execution`);
    const automaticActive =
      run.automaticContinuation.status === 'armed' ||
      run.automaticContinuation.status === 'evaluating' ||
      run.automaticContinuation.status === 'scheduled';
    const conversationRunning = state.runningConvId === conversationId || state.starting;
    if (!automaticActive && !conversationRunning) return;
    await delay(20, signal);
  }
  throw new DOMException('Debug bridge stopped', 'AbortError');
}

async function waitForTerminal(
  terminal: Promise<AgentRuntimeJournalEntry>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<AgentRuntimeJournalEntry> {
  if (signal.aborted) {
    throw new DOMException('Debug bridge stopped', 'AbortError');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException('Debug bridge stopped', 'AbortError')));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Agent debug turn exceeded ${timeoutMs} ms`))),
      timeoutMs,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    terminal.then(
      (entry) => finish(() => resolve(entry)),
      (error) => finish(() => reject(error)),
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
