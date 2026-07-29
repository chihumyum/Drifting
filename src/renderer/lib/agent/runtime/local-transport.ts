import type {
  AgentEventEnvelope,
  AgentStartInput,
  AgentStartRoute,
} from '../protocol';
import type {
  GeneralAgentResult,
  GeneralAgentTransport,
} from '../transport';
import { AgentRuntime } from './runtime';
import { LegacyAgentEventProjector } from './legacy-projection';
import { buildDriftingAgentSystemPrompt } from './system-prompt';
import type {
  AgentClock,
  AgentJournalSink,
  AgentModelDriver,
  AgentModelMessage,
  AgentRuntimeJournalEntry,
  AgentRuntimeLimits,
  AgentToolRuntime,
} from './types';
import { clonePortableData } from './portable-data';

export type RuntimeIdKind = 'session' | 'turn';

export interface RuntimeCryptoSource {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

export interface LocalGeneralAgentTransportDependencies {
  driver: AgentModelDriver;
  tools?: AgentToolRuntime;
  clock?: AgentClock;
  journal?: AgentJournalSink;
  limits?: Partial<AgentRuntimeLimits>;
  createId?: (kind: RuntimeIdKind) => string;
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
}

interface LocalSessionState {
  id: string;
  routeKey: string;
  history: AgentModelMessage[];
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
  private readonly limits?: Partial<AgentRuntimeLimits>;
  private readonly createId: (kind: RuntimeIdKind) => string;
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly sessions = new Map<string, LocalSessionState>();
  private readonly routeSessionIds = new Map<string, string>();
  private readonly seenTurnIds = new Set<string>();
  private active: ActiveTurn | null = null;
  private lastSessionId: string | null = null;

  constructor(dependencies: LocalGeneralAgentTransportDependencies) {
    this.runtime = new AgentRuntime(dependencies);
    this.limits = dependencies.limits;
    this.createId = dependencies.createId ?? createPortableRuntimeId;
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
    if (this.active) {
      return transportError(
        'AGENT_TURN_ALREADY_RUNNING',
        `Agent turn "${this.active.turnId}" is still running.`,
      );
    }
    const route = resolveRoute(input);
    if (!route) {
      return transportError(
        'AGENT_ROUTE_REQUIRED',
        'A canonical route with a matching projectId is required.',
      );
    }

    const routeKey =
      route.kind === 'chat'
        ? `chat:${route.projectId}:${route.conversationId ?? ''}`
        : `goal:${route.projectId}:${route.goalRunId ?? ''}:${route.chapterId ?? ''}`;
    let session: LocalSessionState | undefined;
    if (!input.newConversation && input.resume) {
      session = this.sessions.get(input.resume);
      if (!session) {
        return transportError(
          'AGENT_SESSION_NOT_AVAILABLE',
          'This local Agent session is not available in memory and cannot be resumed.',
        );
      }
      if (session.routeKey !== routeKey) {
        return transportError(
          'AGENT_SESSION_ROUTE_MISMATCH',
          'The Agent session belongs to a different project or conversation.',
        );
      }
    } else if (!input.newConversation) {
      const existingId = this.routeSessionIds.get(routeKey);
      if (existingId) session = this.sessions.get(existingId);
    }
    if (!session) {
      let sessionId: string;
      try {
        sessionId = this.createId('session');
      } catch {
        return transportError(
          'AGENT_ID_UNAVAILABLE',
          'Secure runtime id generation is unavailable.',
        );
      }
      if (this.sessions.has(sessionId)) {
        return transportError(
          'AGENT_ID_CONFLICT',
          `Generated Agent session id "${sessionId}" already exists.`,
        );
      }
      session = { id: sessionId, routeKey, history: [] };
      this.sessions.set(session.id, session);
    }
    this.routeSessionIds.set(routeKey, session.id);
    this.lastSessionId = session.id;

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
    this.seenTurnIds.add(turnId);
    const controller = new AbortController();
    const active: ActiveTurn = { turnId, controller };
    this.active = active;
    const projector = new LegacyAgentEventProjector(session.id);
    let terminalEvents: AgentEventEnvelope['event'][] = [];
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
        terminalEvents = events;
        return;
      }
      for (const event of events) {
        this.publish({ turnId, event });
      }
    };

    const publishTerminal = (): void => {
      for (const event of terminalEvents) {
        if (event.type === 'done' && this.active === active) this.active = null;
        this.publish({ turnId, event });
      }
      terminalEvents = [];
    };

    void this.runtime
      .runTurn({
        sessionId: session.id,
        turnId,
        route,
        prompt: input.prompt,
        systemPrompt: buildDriftingAgentSystemPrompt(input, route),
        ...(input.model ? { model: input.model } : {}),
        reasoning: {
          enabled: input.thinking !== 'off',
          ...(input.effort ? { effort: input.effort } : {}),
        },
        history: session.history,
        ...(this.limits ? { limits: this.limits } : {}),
        signal: controller.signal,
        onEntry: publishProjected,
      })
      .then((result) => {
        if (result.state.modelIterations > 0) {
          session.history = result.messages.map(clonePortableData);
        }
        publishTerminal();
      })
      .catch((error: unknown) => {
        acknowledgeStart(false);
        if (this.active === active) this.active = null;
        if (!didStart) return;
        const message = error instanceof Error ? error.message : String(error);
        this.publish({ turnId, event: { type: 'error', message } });
        this.publish({ turnId, event: { type: 'done' } });
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });

    return (await started)
      ? { ok: true, value: undefined }
      : transportError('AGENT_RUNTIME_START_FAILED', 'The local Agent Runtime failed to start.');
  }

  async abort(): Promise<GeneralAgentResult> {
    this.active?.controller.abort('Agent turn aborted by user');
    return { ok: true, value: undefined };
  }

  async resetSession(): Promise<GeneralAgentResult> {
    if (this.active) {
      return transportError(
        'AGENT_TURN_ALREADY_RUNNING',
        'Cannot reset the Agent session while a turn is running.',
      );
    }
    if (this.lastSessionId) {
      const session = this.sessions.get(this.lastSessionId);
      this.sessions.delete(this.lastSessionId);
      if (session && this.routeSessionIds.get(session.routeKey) === session.id) {
        this.routeSessionIds.delete(session.routeKey);
      }
    }
    this.lastSessionId = null;
    return { ok: true, value: undefined };
  }

  subscribeEvents(
    callback: (event: AgentEventEnvelope) => void,
  ): GeneralAgentResult<() => void> {
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
}

export function createLocalGeneralAgentTransport(
  dependencies: LocalGeneralAgentTransportDependencies,
): GeneralAgentTransport {
  return new LocalGeneralAgentTransport(dependencies);
}
