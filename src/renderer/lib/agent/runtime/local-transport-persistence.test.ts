import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope, AgentStartRoute } from '../protocol';
import { LocalGeneralAgentTransport } from './local-transport';
import { ScriptedFakeDriver } from './testing';
import type {
  AgentTransportCommitTurnInput,
  AgentTransportPersistence,
  AgentTransportPrepareTurnInput,
  AgentTransportPreparedTurn,
} from './transport-persistence';
import type {
  AgentModelMessage,
  AgentRuntimeJournalEntry,
} from './types';

const USAGE = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function finalSteps(text: string) {
  return [
    { op: 'emit' as const, event: { type: 'text_delta' as const, text } },
    { op: 'emit' as const, event: { type: 'usage' as const, usage: USAGE } },
    {
      op: 'emit' as const,
      event: { type: 'finish' as const, reason: 'end_turn' as const },
    },
  ];
}

async function waitForDone(
  events: AgentEventEnvelope[],
  count: number,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (events.filter((event) => event.event.type === 'done').length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} done event(s)`);
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function routeKey(route: AgentStartRoute): string {
  return route.kind === 'chat'
    ? `chat:${route.projectId}:${route.conversationId ?? ''}`
    : `goal:${route.projectId}:${route.goalRunId ?? ''}:${route.chapterId ?? ''}`;
}

class PersistenceError extends Error {
  readonly publicMessage: string;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.publicMessage = message;
  }
}

interface FakeSession {
  id: string;
  routeKey: string;
  history: AgentModelMessage[];
  activeTurnId: string | null;
  interruptedTurns: string[];
}

class FakeTransportPersistence implements AgentTransportPersistence {
  readonly sessions = new Map<string, FakeSession>();
  readonly routeSessions = new Map<string, string>();
  readonly journal: AgentRuntimeJournalEntry[] = [];
  readonly order: string[] = [];
  prepareCalls = 0;
  commitCalls = 0;
  commitGate: Promise<void> | null = null;

  async prepareTurn(
    input: AgentTransportPrepareTurnInput,
  ): Promise<AgentTransportPreparedTurn> {
    this.prepareCalls += 1;
    this.order.push(`prepare:${input.turnId}`);
    const key = routeKey(input.route);
    let session: FakeSession | undefined;
    if (!input.newConversation && input.resumeSessionId) {
      session = this.sessions.get(input.resumeSessionId);
      if (session && session.routeKey !== key) {
        throw new PersistenceError(
          'AGENT_SESSION_ROUTE_MISMATCH',
          'The Agent session belongs to a different project or conversation.',
        );
      }
    } else if (!input.newConversation) {
      const id = this.routeSessions.get(key);
      if (id) session = this.sessions.get(id);
    }
    if (!session) {
      session = {
        id: input.candidateSessionId,
        routeKey: key,
        history: [],
        activeTurnId: null,
        interruptedTurns: [],
      };
      this.sessions.set(session.id, session);
    }
    let recovered = false;
    if (session.activeTurnId) {
      session.interruptedTurns.push(session.activeTurnId);
      session.activeTurnId = null;
      recovered = true;
    }
    session.activeTurnId = input.turnId;
    this.routeSessions.set(key, session.id);
    return {
      sessionId: session.id,
      history: structuredClone(session.history),
      recovered,
    };
  }

  appendJournal(entry: AgentRuntimeJournalEntry): void {
    this.order.push(`journal:${entry.turnId}:${entry.event.type}`);
    this.journal.push(structuredClone(entry));
  }

  async commitTurn(input: AgentTransportCommitTurnInput): Promise<void> {
    this.order.push(`commit-start:${input.turnId}`);
    if (this.commitGate) await this.commitGate;
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error('missing session');
    if (session.activeTurnId !== input.turnId) {
      throw new Error('turn is not active');
    }
    const first = input.turnMessages[0];
    if (first?.role !== 'user') throw new Error('accepted prompt is missing');
    session.history.push(...structuredClone(input.turnMessages));
    session.activeTurnId = null;
    this.commitCalls += 1;
    this.order.push(`commit-done:${input.turnId}`);
  }

  seedInterrupted(
    id: string,
    route: AgentStartRoute,
    completeHistory: AgentModelMessage[],
    turnId: string,
  ): void {
    const key = routeKey(route);
    this.sessions.set(id, {
      id,
      routeKey: key,
      history: structuredClone(completeHistory),
      activeTurnId: turnId,
      interruptedTurns: [],
    });
    this.routeSessions.set(key, id);
  }
}

describe('LocalGeneralAgentTransport persistence boundary', () => {
  it('durably accepts the prompt before provider startup and resumes canonical history after restart', async () => {
    const persistence = new FakeTransportPersistence();
    const firstDriver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: (request) => {
            expect(persistence.order[0]).toBe('prepare:turn-1');
            expect(request.messages).toEqual([
              { role: 'user', content: 'first' },
            ]);
          },
          steps: finalSteps('answer-one'),
        },
      ],
    });
    const first = new LocalGeneralAgentTransport({
      driver: firstDriver,
      persistence,
      createId: (kind) => `${kind}-durable`,
    });
    const firstEvents: AgentEventEnvelope[] = [];
    first.subscribeEvents((event) => firstEvents.push(event));

    await expect(
      first.start({
        prompt: 'first',
        turnId: 'turn-1',
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(firstEvents, 1);

    const secondDriver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            messages: [
              { role: 'user', content: 'first' },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'answer-one' }],
              },
              { role: 'user', content: 'second' },
            ],
          },
          steps: finalSteps('answer-two'),
        },
      ],
    });
    const restarted = new LocalGeneralAgentTransport({
      driver: secondDriver,
      persistence,
      createId: (kind) => `${kind}-after-restart`,
    });
    const restartedEvents: AgentEventEnvelope[] = [];
    restarted.subscribeEvents((event) => restartedEvents.push(event));

    await expect(
      restarted.start({
        prompt: 'second',
        turnId: 'turn-2',
        resume: 'session-durable',
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(restartedEvents, 1);

    expect(persistence.prepareCalls).toBe(2);
    expect(persistence.commitCalls).toBe(2);
    expect(
      persistence.order.indexOf('prepare:turn-1'),
    ).toBeLessThan(
      persistence.order.indexOf('journal:turn-1:turn_started'),
    );
    firstDriver.assertExhausted();
    secondDriver.assertExhausted();
  });

  it('does not publish done until canonical turn messages are committed', async () => {
    const persistence = new FakeTransportPersistence();
    let releaseCommit = (): void => undefined;
    persistence.commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const driver = new ScriptedFakeDriver({
      rounds: [{ steps: finalSteps('durable answer') }],
    });
    const transport = new LocalGeneralAgentTransport({
      driver,
      persistence,
      createId: (kind) => `${kind}-commit-gate`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    await expect(
      transport.start({
        prompt: 'persist me',
        turnId: 'turn-gated',
        route: { kind: 'chat', projectId: 'project-1' },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitUntil(
      () => persistence.order.includes('commit-start:turn-gated'),
      'canonical commit to start',
    );

    expect(persistence.order).toContain('commit-start:turn-gated');
    expect(events.some((event) => event.event.type === 'done')).toBe(false);
    releaseCommit();
    await waitForDone(events, 1);
    expect(persistence.order).toContain('commit-done:turn-gated');
  });

  it('marks a stale active turn interrupted and excludes its incomplete prompt/assistant pair from resumed history', async () => {
    const persistence = new FakeTransportPersistence();
    const route: AgentStartRoute = {
      kind: 'chat',
      projectId: 'project-1',
      conversationId: 'conversation-1',
    };
    persistence.seedInterrupted(
      'session-crashed',
      route,
      [],
      'turn-crashed',
    );
    // A text delta may exist in the immutable journal, but it was never
    // committed as a complete AgentModelMessage.
    persistence.journal.push({
      schemaVersion: 1,
      sessionId: 'session-crashed',
      turnId: 'turn-crashed',
      route,
      seq: 1,
      eventId: 'turn-crashed:1',
      wallTimeMs: 1,
      event: { type: 'text_delta', iteration: 1, text: 'half an answer' },
    });

    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            messages: [
              { role: 'user', content: 'retry safely' },
            ],
          },
          steps: finalSteps('complete answer'),
        },
      ],
    });
    const transport = new LocalGeneralAgentTransport({
      driver,
      persistence,
      createId: (kind) => `${kind}-unused`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    await transport.start({
      prompt: 'retry safely',
      turnId: 'turn-recovered',
      resume: 'session-crashed',
      route,
    });
    await waitForDone(events, 1);

    expect(
      persistence.sessions.get('session-crashed')?.interruptedTurns,
    ).toEqual(['turn-crashed']);
    driver.assertExhausted();
  });

  it('rejects a cross-route resume before calling the provider', async () => {
    const persistence = new FakeTransportPersistence();
    persistence.seedInterrupted(
      'session-owned',
      {
        kind: 'chat',
        projectId: 'project-a',
        conversationId: 'conversation-a',
      },
      [],
      'turn-old',
    );
    const driver = new ScriptedFakeDriver({ rounds: [] });
    const transport = new LocalGeneralAgentTransport({
      driver,
      persistence,
      createId: (kind) => `${kind}-foreign`,
    });

    await expect(
      transport.start({
        prompt: 'foreign',
        turnId: 'turn-foreign',
        resume: 'session-owned',
        route: {
          kind: 'chat',
          projectId: 'project-b',
          conversationId: 'conversation-b',
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_SESSION_ROUTE_MISMATCH',
    });
    expect(driver.calls).toHaveLength(0);
  });
});
