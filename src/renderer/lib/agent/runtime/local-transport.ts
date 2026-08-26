import type {
  AgentAbortInput,
  AgentCancelPendingControlInput,
  AgentEventEnvelope,
  AgentListPendingControlsInput,
  AgentPendingControl,
  AgentPermissionResolutionInput,
  AgentResetSessionInput,
  AgentStartInput,
  AgentStartRoute,
  AgentSteeringInput,
  AgentStopAfterToolInput,
  AgentUserInputResponseInput,
  GeneralAgentAuthStatus,
} from '../protocol';
import type { GeneralAgentResult, GeneralAgentTransport } from '../transport';
import { AgentRuntime } from './runtime';
import { AgentRuntimeControlChannel, AgentRuntimeControlError } from './control-plane';
import { LegacyAgentEventProjector } from './legacy-projection';
import { buildDriftingAgentSystemPrompt } from './system-prompt';
import type { AgentRuntimeContextPlanningOptions } from './runtime-context-planning';
import type {
  AgentClock,
  AgentJournalSink,
  AgentModelDriver,
  AgentModelMessage,
  AgentRuntimeJournalEntry,
  AgentRuntimeLimits,
  AgentToolSelectionStrategy,
  AgentToolPermissionPolicy,
  AgentToolRuntime,
} from './types';
import { AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE } from './types';
import { clonePortableData } from './portable-data';
import type {
  AgentTransportCommitTurnInput,
  AgentTransportPersistence,
} from './transport-persistence';

export type RuntimeIdKind = 'session' | 'turn';

export interface RuntimeCryptoSource {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export interface LocalGeneralAgentTransportDependencies {
  driver: AgentModelDriver;
  tools?: AgentToolRuntime;
  toolSelector?: AgentToolSelectionStrategy;
  contextPlanning?: AgentRuntimeContextPlanningOptions;
  permissionPolicy?: AgentToolPermissionPolicy;
  clock?: AgentClock;
  journal?: AgentJournalSink;
  /** Static limits, or a live getter resolved at every turn start. */
  limits?: Partial<AgentRuntimeLimits> | (() => Partial<AgentRuntimeLimits>);
  createId?: (kind: RuntimeIdKind) => string;
  authStatus?: () => Promise<GeneralAgentAuthStatus>;
  persistence?: AgentTransportPersistence;
}

interface ActiveTurn {
  turnId: string;
  routeKey: string;
  sessionId?: string;
  controller: AbortController;
  control?: AgentRuntimeControlChannel;
}

interface LocalSessionState {
  id: string;
  routeKey: string;
  history: AgentModelMessage[];
}

class AgentTransportCommitError extends Error {
  readonly originalCause: unknown;

  constructor(cause?: unknown) {
    super('The Agent turn could not be durably committed.');
    this.name = 'AgentTransportCommitError';
    this.originalCause = cause;
  }
}

const DURABLE_TURN_COMMIT_ATTEMPTS = 3;

async function commitTurnIdempotently(
  persistence: AgentTransportPersistence,
  input: AgentTransportCommitTurnInput,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < DURABLE_TURN_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      await persistence.commitTurn(input);
      return;
    } catch (cause) {
      failure = cause;
      // Yield once so an ambiguous renderer/native response or a short SQLite
      // contention window can settle. The repository adapter verifies an
      // already-committed turn byte-for-byte, making this retry idempotent.
      if (attempt + 1 < DURABLE_TURN_COMMIT_ATTEMPTS) {
        await Promise.resolve();
      }
    }
  }
  throw failure;
}

function transportError<T = void>(code: string, error: string): GeneralAgentResult<T> {
  return { ok: false, code, error };
}

export function createPortableRuntimeId(
  kind: RuntimeIdKind,
  cryptoSource?: RuntimeCryptoSource,
): string {
  const source = cryptoSource ?? (globalThis.crypto as RuntimeCryptoSource);
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('Secure random values are unavailable');
  }
  const uuid = source.randomUUID?.();
  if (uuid) return `${kind}-${uuid}`;

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  const value = [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
  return `${kind}-${value}`;
}

function resolveRoute(input: AgentStartInput): AgentStartRoute | null {
  if (input.route) {
    if (input.projectId && input.route.projectId !== input.projectId) return null;
    return input.route;
  }
  return input.projectId ? { kind: 'chat', projectId: input.projectId } : null;
}

/**
 * Provider-neutral in-process implementation of the existing transport seam.
 *
 * It is deliberately not installed by default. A future provider adapter can
 * inject an `AgentModelDriver`; Drifting's product remains explicitly
 * unsupported until that adapter and its credential boundary are ready.
 */
export class LocalGeneralAgentTransport implements GeneralAgentTransport {
  readonly capability = { available: true, kind: 'local' as const };

  private readonly runtime: AgentRuntime;
  private readonly limits?:
    | Partial<AgentRuntimeLimits>
    | (() => Partial<AgentRuntimeLimits>);
  private readonly createId: (kind: RuntimeIdKind) => string;
  private readonly resolveAuthStatus?: () => Promise<GeneralAgentAuthStatus>;
  private readonly supportsReasoning: boolean;
  private readonly driverId: string;
  private readonly persistence?: AgentTransportPersistence;
  private readonly wallNowMs: () => number;
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly journalListeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  private readonly sessions = new Map<string, LocalSessionState>();
  private readonly routeSessionIds = new Map<string, string>();
  private readonly seenTurnIds = new Set<string>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeRouteTurns = new Map<string, string>();

  constructor(dependencies: LocalGeneralAgentTransportDependencies) {
    this.persistence = dependencies.persistence;
    const journal =
      dependencies.persistence || dependencies.journal
        ? createTransportJournal(dependencies.persistence, dependencies.journal)
        : undefined;
    this.runtime = new AgentRuntime({
      driver: dependencies.driver,
      ...(dependencies.tools ? { tools: dependencies.tools } : {}),
      ...(dependencies.toolSelector ? { toolSelector: dependencies.toolSelector } : {}),
      ...(dependencies.contextPlanning ? { contextPlanning: dependencies.contextPlanning } : {}),
      ...(dependencies.permissionPolicy ? { permissionPolicy: dependencies.permissionPolicy } : {}),
      ...(dependencies.clock ? { clock: dependencies.clock } : {}),
      ...(journal ? { journal } : {}),
    });
    this.limits = dependencies.limits;
    this.createId = dependencies.createId ?? createPortableRuntimeId;
    this.resolveAuthStatus = dependencies.authStatus;
    this.driverId = dependencies.driver.id;
    this.wallNowMs = dependencies.clock?.wallNowMs.bind(dependencies.clock) ?? Date.now;
    this.supportsReasoning = dependencies.driver.capabilities?.reasoning !== false;
  }

  async authPrepare(): Promise<GeneralAgentResult<{ url: string }>> {
    return transportError(
      'AGENT_AUTH_NOT_SUPPORTED',
      'Authentication belongs to the installed provider adapter.',
    );
  }

  async authSubmitCode(_code: string): Promise<GeneralAgentResult> {
    return transportError(
      'AGENT_AUTH_NOT_SUPPORTED',
      'Authentication belongs to the installed provider adapter.',
    );
  }

  async authStatus(): Promise<
    GeneralAgentResult<{
      byokConnected: boolean;
      apiKeyConnected: boolean;
      hostedAvailable: boolean;
    }>
  > {
    if (this.resolveAuthStatus) {
      try {
        return { ok: true, value: await this.resolveAuthStatus() };
      } catch {
        return transportError(
          'AGENT_AUTH_STATUS_FAILED',
          'Agent credential status could not be read.',
        );
      }
    }
    return {
      ok: true,
      value: {
        byokConnected: false,
        apiKeyConnected: false,
        hostedAvailable: false,
      },
    };
  }

  async authLogout(): Promise<GeneralAgentResult> {
    return { ok: true, value: undefined };
  }

  async start(input: AgentStartInput): Promise<GeneralAgentResult> {
    const route = resolveRoute(input);
    if (!route) {
      return transportError(
        'AGENT_ROUTE_REQUIRED',
        'A canonical route with a matching projectId is required.',
      );
    }

    let turnId = input.turnId;
    if (!turnId) {
      try {
        turnId = this.createId('turn');
      } catch {
        return transportError(
          'AGENT_ID_UNAVAILABLE',
          'Secure runtime id generation is unavailable.',
        );
      }
    }
    if (this.seenTurnIds.has(turnId)) {
      return transportError(
        'AGENT_TURN_ID_CONFLICT',
        `Agent turn id "${turnId}" has already been used.`,
      );
    }
    const routeKey = routeKeyFor(route);
    const routeTurnId = this.activeRouteTurns.get(routeKey);
    if (routeTurnId) {
      return transportError(
        'AGENT_ROUTE_ALREADY_RUNNING',
        `Agent turn "${routeTurnId}" is still running for this conversation.`,
      );
    }
    this.seenTurnIds.add(turnId);
    const controller = new AbortController();
    const active: ActiveTurn = { turnId, routeKey, controller };
    this.activeTurns.set(turnId, active);
    this.activeRouteTurns.set(routeKey, turnId);
    let candidateSessionId: string;
    try {
      candidateSessionId = this.createId('session');
    } catch {
      this.releaseActiveTurn(active);
      return transportError('AGENT_ID_UNAVAILABLE', 'Secure runtime id generation is unavailable.');
    }

    let session: LocalSessionState;
    if (this.persistence) {
      try {
        const prepared = await this.persistence.prepareTurn(
          {
            candidateSessionId,
            ...(input.resume ? { resumeSessionId: input.resume } : {}),
            newConversation: input.newConversation === true,
            route,
            provider: input.provider ?? this.driverId,
            model: input.model ?? null,
            turnId,
            prompt: input.prompt,
            acceptedAt: this.nowIso(),
          },
          controller.signal,
        );
        session = {
          id: prepared.sessionId,
          routeKey,
          history: prepared.history.map(clonePortableData),
        };
        this.sessions.set(session.id, session);
      } catch (error) {
        this.releaseActiveTurn(active);
        return transportError(persistenceErrorCode(error), persistenceErrorMessage(error));
      }
    } else {
      const resolved = this.resolveMemorySession(
        routeKey,
        input.resume,
        input.newConversation === true,
        candidateSessionId,
      );
      if (!resolved.ok) {
        this.releaseActiveTurn(active);
        return resolved.result;
      }
      session = resolved.session;
    }
    this.routeSessionIds.set(routeKey, session.id);
    active.sessionId = session.id;
    const control = new AgentRuntimeControlChannel(session.id, turnId);
    active.control = control;
    const projector = new LegacyAgentEventProjector(session.id);
    let terminalEvents: AgentEventEnvelope['event'][] = [];
    let terminalEntry: AgentRuntimeJournalEntry | null = null;
    let didStart = false;

    let acknowledgeStart: (started: boolean) => void = () => undefined;
    const started = new Promise<boolean>((resolve) => {
      acknowledgeStart = resolve;
    });

    const publishProjected = (entry: AgentRuntimeJournalEntry): void => {
      if (entry.event.type === 'turn_started') {
        didStart = true;
        acknowledgeStart(true);
      }
      const events = projector.project(entry);
      if (entry.event.type === 'turn_finished') {
        terminalEntry = entry;
        terminalEvents = events;
        return;
      }
      this.publishJournal(entry);
      for (const event of events) {
        this.publish({ turnId, event });
      }
    };

    // Transient entries carry the character-level thinking stream that the
    // durable journal consolidates into one row per run. They reach live
    // subscribers exactly like durable entries but are never persisted.
    const publishTransient = (entry: AgentRuntimeJournalEntry): void => {
      this.publishJournal(entry);
      for (const event of projector.project(entry)) {
        this.publish({ turnId, event });
      }
    };

    const publishTerminal = (): void => {
      if (terminalEntry) this.publishJournal(terminalEntry);
      terminalEntry = null;
      for (const event of terminalEvents) {
        if (event.type === 'done') this.releaseActiveTurn(active);
        this.publish({ turnId, event });
      }
      terminalEvents = [];
    };

    // Limits may be a live getter (for example the settings store) so a changed
    // preference applies to the next turn without rebuilding the transport.
    const turnLimits = typeof this.limits === 'function' ? this.limits() : this.limits;
    void this.runtime
      .runTurn({
        sessionId: session.id,
        turnId,
        route,
        prompt: input.prompt,
        ...(input.promptSource ? { promptSource: input.promptSource } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        systemPrompt: buildDriftingAgentSystemPrompt(input, route),
        ...(input.model ? { model: input.model } : {}),
        ...(input.contextMode ? { contextMode: input.contextMode } : {}),
        reasoning: !this.supportsReasoning
          ? { enabled: false }
          : {
              enabled: input.thinking !== 'off',
              ...(input.effort ? { effort: input.effort } : {}),
            },
        toolSearch: input.toolSearch ?? 'off',
        toolAccess: input.toolAccess ?? 'read_write',
        history: session.history,
        ...(turnLimits ? { limits: turnLimits } : {}),
        signal: controller.signal,
        control,
        onEntry: publishProjected,
        onTransientEntry: publishTransient,
      })
      .then(async (result) => {
        if (this.persistence) {
          const priorHistoryLength = session.history.length;
          try {
            if (result.state.status === 'completed' && !result.completedContextCheckpoint) {
              throw new AgentTransportCommitError();
            }
            await commitTurnIdempotently(this.persistence, {
              sessionId: session.id,
              turnId,
              turnMessages: result.messages.slice(priorHistoryLength).map(clonePortableData),
              ...(result.completedContextCheckpoint
                ? {
                    contextCheckpointV2: clonePortableData(result.completedContextCheckpoint),
                  }
                : {}),
              outcome: runtimeOutcome(result.state.status),
              errorCode: result.state.terminal?.failureCode ?? null,
              errorMessage: result.state.terminal?.message ?? null,
              endedAt: this.nowIso(),
            });
          } catch (cause) {
            // Keep the raw persistence/checkpoint cause out of the transcript,
            // but retain it in the local developer console. Previously every
            // failure collapsed to the same public sentence, which made a
            // successful write followed by a failed context commit impossible
            // to distinguish from a database conflict.
            console.error('[agent] durable turn commit failed', cause);
            throw new AgentTransportCommitError(cause);
          }
          session.history = result.messages.map(clonePortableData);
        } else if (result.state.modelIterations > 0) {
          session.history = result.messages.map(clonePortableData);
        }
        publishTerminal();
      })
      .catch((error: unknown) => {
        acknowledgeStart(false);
        this.releaseActiveTurn(active);
        if (!didStart) return;
        // The immutable computational terminal was already appended, but the
        // normalized message/checkpoint commit failed. Project it live as a
        // fail-closed terminal so the UI cannot present an uncommitted slice as
        // completed. Recovery derives the same overlay from the durable turn
        // row plus journal.
        if (terminalEntry) {
          this.publishJournal(failClosedCommitTerminal(terminalEntry));
        }
        terminalEntry = null;
        terminalEvents = [];
        const message = error instanceof Error ? error.message : String(error);
        this.publish({ turnId, event: { type: 'error', message } });
        this.publish({ turnId, event: { type: 'done' } });
      })
      .finally(() => {
        this.releaseActiveTurn(active);
      });

    return (await started)
      ? { ok: true, value: undefined }
      : transportError('AGENT_RUNTIME_START_FAILED', 'The local Agent Runtime failed to start.');
  }

  async resolvePermission(input: AgentPermissionResolutionInput): Promise<GeneralAgentResult> {
    const control = this.activeTurns.get(input.turnId)?.control;
    if (!control || control.sessionId !== input.sessionId) {
      return transportError(
        'AGENT_CONTINUATION_REQUIRED',
        'The original Agent execution stack is unavailable; this permission cannot be resumed directly.',
      );
    }
    return runControlCommand(() => control.resolvePermission(input));
  }

  async submitUserInput(input: AgentUserInputResponseInput): Promise<GeneralAgentResult> {
    const control = this.activeTurns.get(input.turnId)?.control;
    if (!control || control.sessionId !== input.sessionId) {
      return transportError(
        'AGENT_CONTINUATION_REQUIRED',
        'The original Agent execution stack is unavailable; this answer was not accepted.',
      );
    }
    return runControlCommand(() => control.submitUserInput(input));
  }

  async steer(input: AgentSteeringInput): Promise<GeneralAgentResult> {
    const control = this.activeTurns.get(input.turnId)?.control;
    if (!control) {
      return transportError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'There is no matching active Agent turn to steer.',
      );
    }
    return runControlCommand(() => control.steer(input));
  }

  async stopAfterTool(input: AgentStopAfterToolInput): Promise<GeneralAgentResult> {
    const control = this.activeTurns.get(input.turnId)?.control;
    if (!control) {
      return transportError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'There is no matching active Agent turn to stop.',
      );
    }
    return runControlCommand(() => control.stopAfterTool(input));
  }

  async listPendingControls(
    input: AgentListPendingControlsInput,
  ): Promise<GeneralAgentResult<AgentPendingControl[]>> {
    const activePending = [...this.activeTurns.values()]
      .find((active) => active.control?.sessionId === input.sessionId)
      ?.control?.pendingControl() ?? null;
    if (activePending) return { ok: true, value: [activePending] };
    if (!this.persistence?.listPendingControls) {
      return { ok: true, value: [] };
    }
    try {
      return {
        ok: true,
        value: await this.persistence.listPendingControls(input),
      };
    } catch (error) {
      return transportError(persistenceErrorCode(error), persistenceErrorMessage(error));
    }
  }

  async cancelPendingControl(input: AgentCancelPendingControlInput): Promise<GeneralAgentResult> {
    const active = this.activeTurns.get(input.turnId);
    const activePending = active?.control?.pendingControl();
    if (
      activePending &&
      activePending.sessionId === input.sessionId &&
      activePending.turnId === input.turnId &&
      (activePending.permissionRequest?.requestId === input.requestId ||
        activePending.userInputRequest?.requestId === input.requestId)
    ) {
      return runControlCommand(() =>
        active!.control!.requestCancellation(
          input.reason ?? 'Recovered control cancelled by user',
        ),
      );
    }
    if (!this.persistence?.cancelPendingControl) {
      return transportError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'No matching pending Agent control was found.',
      );
    }
    try {
      await this.persistence.cancelPendingControl(input);
      return { ok: true, value: undefined };
    } catch (error) {
      return transportError(persistenceErrorCode(error), persistenceErrorMessage(error));
    }
  }

  async abort(input: AgentAbortInput = {}): Promise<GeneralAgentResult> {
    let active: ActiveTurn | undefined;
    if (input.turnId) {
      active = this.activeTurns.get(input.turnId);
      if (!active) {
        return transportError(
          'AGENT_CONTROL_NOT_ACTIVE',
          `There is no active Agent turn "${input.turnId}" to abort.`,
        );
      }
    } else if (this.activeTurns.size === 1) {
      active = this.activeTurns.values().next().value;
    } else if (this.activeTurns.size > 1) {
      return transportError(
        'AGENT_TURN_REQUIRED',
        'A turnId is required when more than one Agent turn is active.',
      );
    }
    if (active?.control) {
      const result = await runControlCommand(() =>
        active.control!.requestCancellation('Agent turn aborted by user'),
      );
      if (result.ok) return result;
    }
    active?.controller.abort('Agent turn aborted by user');
    return { ok: true, value: undefined };
  }

  async resetSession(input: AgentResetSessionInput = {}): Promise<GeneralAgentResult> {
    let sessionId = input.sessionId;
    if (!sessionId && this.sessions.size === 1) {
      sessionId = this.sessions.keys().next().value;
    }
    if (!sessionId && this.sessions.size > 1) {
      return transportError(
        'AGENT_SESSION_REQUIRED',
        'A sessionId is required when more than one Agent session is loaded.',
      );
    }
    if (!sessionId) return { ok: true, value: undefined };
    if ([...this.activeTurns.values()].some((active) => active.sessionId === sessionId)) {
      return transportError(
        'AGENT_TURN_ALREADY_RUNNING',
        `Cannot reset Agent session "${sessionId}" while its turn is running.`,
      );
    }
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session && this.routeSessionIds.get(session.routeKey) === session.id) {
      this.routeSessionIds.delete(session.routeKey);
    }
    return { ok: true, value: undefined };
  }

  subscribeJournal(
    callback: (entry: AgentRuntimeJournalEntry) => void,
  ): GeneralAgentResult<() => void> {
    this.journalListeners.add(callback);
    return {
      ok: true,
      value: () => {
        this.journalListeners.delete(callback);
      },
    };
  }

  subscribeEvents(callback: (event: AgentEventEnvelope) => void): GeneralAgentResult<() => void> {
    this.listeners.add(callback);
    return {
      ok: true,
      value: () => {
        this.listeners.delete(callback);
      },
    };
  }

  private publish(envelope: AgentEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        // UI projections cannot break runtime progress or other subscribers.
      }
    }
  }

  private publishJournal(entry: AgentRuntimeJournalEntry): void {
    for (const listener of this.journalListeners) {
      try {
        listener(entry);
      } catch {
        // UI projections cannot break runtime progress or other subscribers.
      }
    }
  }

  private resolveMemorySession(
    routeKey: string,
    resume: string | undefined,
    newConversation: boolean,
    candidateSessionId: string,
  ): { ok: true; session: LocalSessionState } | { ok: false; result: GeneralAgentResult } {
    let session: LocalSessionState | undefined;
    if (!newConversation && resume) {
      session = this.sessions.get(resume);
      if (session && session.routeKey !== routeKey) {
        return {
          ok: false,
          result: transportError(
            'AGENT_SESSION_ROUTE_MISMATCH',
            'The Agent session belongs to a different project or conversation.',
          ),
        };
      }
    } else if (!newConversation) {
      const existingId = this.routeSessionIds.get(routeKey);
      if (existingId) session = this.sessions.get(existingId);
    }
    if (session) return { ok: true, session };
    if (this.sessions.has(candidateSessionId)) {
      return {
        ok: false,
        result: transportError(
          'AGENT_ID_CONFLICT',
          `Generated Agent session id "${candidateSessionId}" already exists.`,
        ),
      };
    }
    session = { id: candidateSessionId, routeKey, history: [] };
    this.sessions.set(session.id, session);
    return { ok: true, session };
  }

  private nowIso(): string {
    return new Date(this.wallNowMs()).toISOString();
  }

  private releaseActiveTurn(active: ActiveTurn): void {
    if (this.activeTurns.get(active.turnId) === active) {
      this.activeTurns.delete(active.turnId);
    }
    if (this.activeRouteTurns.get(active.routeKey) === active.turnId) {
      this.activeRouteTurns.delete(active.routeKey);
    }
  }
}

function failClosedCommitTerminal(entry: AgentRuntimeJournalEntry): AgentRuntimeJournalEntry {
  if (entry.event.type !== 'turn_finished') return entry;
  return {
    ...entry,
    event: {
      ...entry.event,
      outcome: 'failed',
      failureCode: 'INTERNAL_ERROR',
      message: AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
    },
  };
}

export function createLocalGeneralAgentTransport(
  dependencies: LocalGeneralAgentTransportDependencies,
): GeneralAgentTransport {
  return new LocalGeneralAgentTransport(dependencies);
}

function routeKeyFor(route: AgentStartRoute): string {
  return route.kind === 'chat'
    ? `chat:${route.projectId}:${route.conversationId ?? ''}`
    : `goal:${route.projectId}:${route.goalRunId ?? ''}:${route.chapterId ?? ''}`;
}

function createTransportJournal(
  persistence: AgentTransportPersistence | undefined,
  observer: AgentJournalSink | undefined,
): AgentJournalSink {
  return {
    async append(entry, signal) {
      if (persistence) await persistence.appendJournal(entry, signal);
      if (observer) await observer.append(entry, signal);
    },
  };
}

function runtimeOutcome(
  status:
    | 'idle'
    | 'running'
    | 'waiting_permission'
    | 'waiting_user'
    | 'cancelling'
    | 'committing'
    | 'completed'
    | 'failed'
    | 'aborted'
    | 'budget_exceeded',
): import('./types').AgentRuntimeOutcome {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'aborted':
    case 'budget_exceeded':
      return status;
    case 'idle':
    case 'running':
    case 'waiting_permission':
    case 'waiting_user':
    case 'cancelling':
    case 'committing':
      return 'failed';
  }
}

function persistenceErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'AGENT_PERSISTENCE_START_FAILED';
}

function persistenceErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'publicMessage' in error &&
    typeof error.publicMessage === 'string'
  ) {
    return error.publicMessage;
  }
  return 'The Agent turn could not be durably accepted.';
}

async function runControlCommand(command: () => Promise<void>): Promise<GeneralAgentResult> {
  try {
    await command();
    return { ok: true, value: undefined };
  } catch (error) {
    if (error instanceof AgentRuntimeControlError) {
      return transportError(error.code, error.publicMessage);
    }
    return transportError(
      'AGENT_CONTROL_FAILED',
      error instanceof Error ? error.message : 'The Agent control command failed.',
    );
  }
}
