import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '../protocol';
import { LocalGeneralAgentTransport } from './local-transport';
import { ManualAgentClock, ScriptedFakeDriver } from './testing';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentRuntimeJournalEntry,
  AgentToolRuntime,
} from './types';
import { AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE } from './types';
import type { AgentTransportPersistence } from './transport-persistence';

const USAGE = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

class ConcurrentTransportDriver implements AgentModelDriver {
  readonly id = 'concurrent-transport-driver';
  activeStreams = 0;
  maxActiveStreams = 0;
  private releaseBarrier: () => void = () => undefined;
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  async *stream(_request: AgentModelRequest) {
    this.activeStreams += 1;
    this.maxActiveStreams = Math.max(this.maxActiveStreams, this.activeStreams);
    try {
      await this.barrier;
      yield { type: 'text_delta' as const, text: 'done' };
      yield { type: 'usage' as const, usage: USAGE };
      yield { type: 'finish' as const, reason: 'end_turn' as const };
    } finally {
      this.activeStreams -= 1;
    }
  }

  async waitUntilActive(count: number): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (this.activeStreams >= count) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Expected ${count} concurrent provider streams`);
  }

  release(): void {
    this.releaseBarrier();
  }
}

async function waitForDone(events: AgentEventEnvelope[], count: number): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (events.filter((event) => event.event.type === 'done').length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${count} done event(s)`);
}

describe('LocalGeneralAgentTransport', () => {
  it('imposes no app admission cap and requires scoped control while conversations overlap', async () => {
    const driver = new ConcurrentTransportDriver();
    let sessionOrdinal = 0;
    const transport = new LocalGeneralAgentTransport({
      driver,
      createId: (kind) =>
        kind === 'session' ? `session-${(sessionOrdinal += 1)}` : `generated-${kind}`,
    });
    const events: AgentEventEnvelope[] = [];
    const journal: AgentRuntimeJournalEntry[] = [];
    transport.subscribeEvents((event) => events.push(event));
    transport.subscribeJournal((entry) => journal.push(entry));

    const initialCount = 40;
    const starts = Array.from({ length: initialCount }, (_, index) =>
      transport.start({
        prompt: `task ${index}`,
        turnId: `turn-${index}`,
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: `conversation-${index}`,
        },
      }),
    );
    await driver.waitUntilActive(initialCount);
    expect(await Promise.all(starts)).toEqual(
      Array.from({ length: initialCount }, () => ({ ok: true, value: undefined })),
    );

    await expect(transport.abort()).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_TURN_REQUIRED',
    });
    await expect(transport.abort({ turnId: 'turn-0' })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      transport.start({
        prompt: 'same route',
        turnId: 'turn-same-route',
        route: { kind: 'chat', projectId: 'project-1', conversationId: 'conversation-0' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_ROUTE_ALREADY_RUNNING' });
    const extra = transport.start({
      prompt: 'extra task beyond the former internal ceiling',
      turnId: 'turn-extra',
      route: { kind: 'chat', projectId: 'project-1', conversationId: 'conversation-extra' },
    });
    await driver.waitUntilActive(initialCount + 1);
    await expect(extra).resolves.toEqual({ ok: true, value: undefined });

    driver.release();
    await waitForDone(events, initialCount + 1);
    expect(driver.maxActiveStreams).toBe(initialCount + 1);
    const firstEvents = events.filter((event) => event.turnId === 'turn-0');
    const secondEvents = events.filter((event) => event.turnId === 'turn-1');
    expect(firstEvents[firstEvents.length - 1]?.event.type).toBe('done');
    expect(secondEvents[secondEvents.length - 1]?.event.type).toBe('done');
    expect(
      journal.find(
        (entry) => entry.turnId === 'turn-0' && entry.event.type === 'turn_finished',
      )?.event,
    ).toMatchObject({ outcome: 'aborted' });
    expect(
      journal.find(
        (entry) => entry.turnId === 'turn-1' && entry.event.type === 'turn_finished',
      )?.event,
    ).toMatchObject({ outcome: 'completed' });
    expect(
      journal.find(
        (entry) => entry.turnId === 'turn-extra' && entry.event.type === 'turn_finished',
      )?.event,
    ).toMatchObject({ outcome: 'completed' });
  });

  it('projects an interactive permission wait and validates the full resolution binding', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            {
              op: 'emit',
              event: { type: 'tool_call_start', callId: 'write-1', name: 'write' },
            },
            {
              op: 'emit',
              event: {
                type: 'tool_args_delta',
                callId: 'write-1',
                delta: '{"expectedRevision":"rev-1"}',
              },
            },
            {
              op: 'emit',
              event: { type: 'tool_call_end', callId: 'write-1' },
            },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'written' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const tools: AgentToolRuntime = {
      listDefinitions: () => [
        {
          name: 'write',
          description: 'write',
          inputSchema: { type: 'object' },
          access: 'write',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      execute: async () => ({ ok: true, data: 'ok' }),
    };
    const transport = new LocalGeneralAgentTransport({
      driver,
      tools,
      permissionPolicy: { decide: () => ({ decision: 'ask' }) },
      createId: (kind) => `${kind}-permission`,
    });
    const events: AgentEventEnvelope[] = [];
    const journal: AgentRuntimeJournalEntry[] = [];
    transport.subscribeEvents((event) => events.push(event));
    transport.subscribeJournal((entry) => journal.push(entry));
    await transport.start({
      prompt: 'write',
      turnId: 'turn-permission',
      route: { kind: 'chat', projectId: 'project-1' },
    });
    for (let index = 0; index < 100; index += 1) {
      if (events.some((event) => event.event.type === 'permission_request')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const requestEvent = events.find((event) => event.event.type === 'permission_request')?.event;
    if (!requestEvent || requestEvent.type !== 'permission_request') {
      throw new Error('missing permission request');
    }
    await expect(
      transport.resolvePermission({
        requestId: requestEvent.request.requestId,
        sessionId: requestEvent.request.sessionId,
        turnId: requestEvent.request.turnId,
        callId: requestEvent.request.callId,
        argumentsHash: `sha256:${'0'.repeat(64)}`,
        revision: requestEvent.request.revision,
        decision: 'allow',
        scope: 'once',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_CONTROL_STALE' });
    await expect(
      transport.resolvePermission({
        requestId: requestEvent.request.requestId,
        sessionId: requestEvent.request.sessionId,
        turnId: requestEvent.request.turnId,
        callId: requestEvent.request.callId,
        argumentsHash: requestEvent.request.argumentsHash,
        revision: requestEvent.request.revision,
        decision: 'allow',
        scope: 'once',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);
    expect(journal.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining([
        'tool_call_started',
        'tool_args_delta',
        'tool_call_ready',
        'permission_requested',
        'permission_resolved',
        'tool_execution_started',
        'tool_result',
        'text_delta',
        'turn_finished',
      ]),
    );
    expect(journal.find((entry) => entry.event.type === 'tool_args_delta')?.event).toMatchObject({
      type: 'tool_args_delta',
      delta: '{"expectedRevision":"rev-1"}',
    });
    expect(events.map((event) => event.event.type)).toEqual(
      expect.arrayContaining([
        'permission_request',
        'permission_resolved',
        'control_state',
        'done',
      ]),
    );
  });

  it('projects canonical entries, keeps session history, and emits done last once per turn', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            iteration: 1,
            messages: [{ role: 'user', content: 'first' }],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'one' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
        {
          expectRequest: {
            iteration: 1,
            messages: [
              { role: 'user', content: 'first' },
              { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
              { role: 'user', content: 'second' },
            ],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'two' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const transport = new LocalGeneralAgentTransport({
      driver,
      clock,
      createId: (kind) => `${kind}-fixed`,
    });
    const events: AgentEventEnvelope[] = [];
    const subscription = transport.subscribeEvents((event) => events.push(event));
    expect(subscription.ok).toBe(true);

    expect(
      await transport.start({
        prompt: 'first',
        turnId: 'turn-1',
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
      }),
    ).toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    expect(
      await transport.start({
        prompt: 'second',
        turnId: 'turn-2',
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
      }),
    ).toEqual({ ok: true, value: undefined });
    await waitForDone(events, 2);

    const first = events.filter((event) => event.turnId === 'turn-1');
    const second = events.filter((event) => event.turnId === 'turn-2');
    for (const turn of [first, second]) {
      expect(turn.map((event) => event.event.type)).toEqual([
        'session',
        'assistant_delta',
        'control_state',
        'usage',
        'result',
        'done',
      ]);
      expect(turn.filter((event) => event.event.type === 'done')).toHaveLength(1);
      expect(turn[turn.length - 1].event.type).toBe('done');
      expect(turn[0].event).toEqual({ type: 'session', id: 'session-fixed' });
    }
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('aborts an active local turn and remains resettable after the final done', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({
      rounds: [{ steps: [{ op: 'wait', gate: 'waiting-provider' }] }],
    });
    const transport = new LocalGeneralAgentTransport({
      driver,
      clock,
      createId: (kind) => `${kind}-abort`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    const started = transport.start({
      prompt: 'wait',
      turnId: 'turn-abort',
      projectId: 'project-1',
    });
    await driver.waitUntilGate('waiting-provider');
    expect(await started).toEqual({ ok: true, value: undefined });
    expect(await transport.abort()).toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    expect(events.map((event) => event.event.type)).toEqual([
      'session',
      'control_state',
      'control_state',
      'usage',
      'done',
    ]);
    expect(await transport.resetSession()).toEqual({ ok: true, value: undefined });
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('projects a post-start journal failure only through its canonical terminal', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({ rounds: [] });
    let appendCalls = 0;
    const transport = new LocalGeneralAgentTransport({
      driver,
      clock,
      createId: (kind) => `${kind}-journal`,
      journal: {
        append: () => {
          appendCalls += 1;
          if (appendCalls === 2) throw new Error('journal unavailable');
        },
      },
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    expect(
      await transport.start({
        prompt: 'journal',
        turnId: 'turn-journal',
        projectId: 'project-1',
      }),
    ).toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    expect(events.map((event) => event.event.type)).toEqual([
      'session',
      'control_state',
      'usage',
      'error',
      'done',
    ]);
    expect(events[3].event).toEqual({
      type: 'error',
      message: 'Agent journal persistence failed',
    });
    expect(events.filter((event) => event.event.type === 'done')).toHaveLength(1);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('fails the live canonical terminal closed when the completed turn cannot commit', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'draft result' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    let commitAttempts = 0;
    const persistence: AgentTransportPersistence = {
      prepareTurn: async () => ({
        sessionId: 'session-commit',
        history: [],
        recovered: false,
      }),
      appendJournal: async () => undefined,
      commitTurn: async () => {
        commitAttempts += 1;
        throw new Error('sqlite commit failed');
      },
    };
    const transport = new LocalGeneralAgentTransport({
      driver,
      persistence,
      createId: (kind) => `${kind}-commit`,
    });
    const events: AgentEventEnvelope[] = [];
    const journal: AgentRuntimeJournalEntry[] = [];
    transport.subscribeEvents((event) => events.push(event));
    transport.subscribeJournal((entry) => journal.push(entry));

    await expect(
      transport.start({
        prompt: 'commit this',
        turnId: 'turn-commit',
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    const terminals = journal.filter((entry) => entry.event.type === 'turn_finished');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.event).toMatchObject({
      type: 'turn_finished',
      outcome: 'failed',
      failureCode: 'INTERNAL_ERROR',
      message: AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
    });
    expect(commitAttempts).toBe(3);
  });

  it('retries an idempotent durable commit before publishing the completed terminal', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'durable result' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    let commitAttempts = 0;
    const persistence: AgentTransportPersistence = {
      prepareTurn: async () => ({
        sessionId: 'session-retry',
        history: [],
        recovered: false,
      }),
      appendJournal: async () => undefined,
      commitTurn: async () => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw new Error('lost commit response');
      },
    };
    const transport = new LocalGeneralAgentTransport({
      driver,
      persistence,
      createId: (kind) => `${kind}-retry`,
    });
    const events: AgentEventEnvelope[] = [];
    const journal: AgentRuntimeJournalEntry[] = [];
    transport.subscribeEvents((event) => events.push(event));
    transport.subscribeJournal((entry) => journal.push(entry));

    await expect(
      transport.start({
        prompt: 'retry commit',
        turnId: 'turn-retry',
        projectId: 'project-1',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    expect(commitAttempts).toBe(2);
    expect(events.some((entry) => entry.event.type === 'error')).toBe(false);
    expect(journal[journal.length - 1]?.event).toMatchObject({
      type: 'turn_finished',
      outcome: 'completed',
    });
  });

  it('isolates histories by route and resumes only a known matching session', async () => {
    const clock = new ManualAgentClock();
    const finalSteps = (text: string) => [
      { op: 'emit' as const, event: { type: 'text_delta' as const, text } },
      { op: 'emit' as const, event: { type: 'usage' as const, usage: USAGE } },
      { op: 'emit' as const, event: { type: 'finish' as const, reason: 'end_turn' as const } },
    ];
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: (request) => {
            expect(request.messages).toEqual([{ role: 'user', content: 'A1' }]);
            expect(request.systemPrompt).toContain('only project "project-a"');
            expect(request.systemPrompt).not.toContain('Write manuscript-facing content in');
            expect(request.systemPrompt).toContain('POV: first person');
            expect(request.systemPrompt).toContain('[ruling] keep the ending');
          },
          steps: finalSteps('answer-a1'),
        },
        {
          expectRequest: {
            messages: [{ role: 'user', content: 'B1' }],
          },
          steps: finalSteps('answer-b1'),
        },
        {
          expectRequest: {
            messages: [
              { role: 'user', content: 'A1' },
              { role: 'assistant', content: [{ type: 'text', text: 'answer-a1' }] },
              { role: 'user', content: 'A2' },
            ],
          },
          steps: finalSteps('answer-a2'),
        },
      ],
    });
    let sessionCounter = 0;
    const transport = new LocalGeneralAgentTransport({
      driver,
      clock,
      createId: (kind) =>
        kind === 'session' ? `session-${++sessionCounter}` : `turn-${sessionCounter}`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    await transport.start({
      prompt: 'A1',
      turnId: 'turn-a1',
      route: { kind: 'chat', projectId: 'project-a', conversationId: 'conversation-a' },
      projectFacts: [{ key: 'POV', value: 'first person' }],
      memories: [{ kind: 'ruling', body: 'keep the ending' }],
    });
    await waitForDone(events, 1);
    const sessionA = events.find(
      (event) => event.turnId === 'turn-a1' && event.event.type === 'session',
    );
    if (sessionA?.event.type !== 'session') throw new Error('missing session A');

    await transport.start({
      prompt: 'B1',
      turnId: 'turn-b1',
      route: { kind: 'chat', projectId: 'project-b', conversationId: 'conversation-b' },
    });
    await waitForDone(events, 2);

    await transport.start({
      prompt: 'A2',
      turnId: 'turn-a2',
      resume: sessionA.event.id,
      route: { kind: 'chat', projectId: 'project-a', conversationId: 'conversation-a' },
    });
    await waitForDone(events, 3);

    const sessionIds = events
      .filter((event) => event.event.type === 'session')
      .map((event) => (event.event.type === 'session' ? event.event.id : ''));
    expect(sessionIds).toEqual(['session-1', 'session-2', 'session-1']);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('retains an already-committed write in session history when the turn is aborted', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            {
              op: 'emit',
              event: { type: 'tool_call_start', callId: 'write-1', name: 'write' },
            },
            {
              op: 'emit',
              event: { type: 'tool_args_delta', callId: 'write-1', delta: '{}' },
            },
            {
              op: 'emit',
              event: { type: 'tool_call_end', callId: 'write-1' },
            },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: {
            messages: [
              { role: 'user', content: 'write once' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_call',
                    callId: 'write-1',
                    name: 'write',
                    arguments: {},
                    rawArguments: '{}',
                  },
                ],
              },
              {
                role: 'tool',
                content: [
                  {
                    callId: 'write-1',
                    name: 'write',
                    ok: true,
                    content: 'committed',
                  },
                ],
              },
              { role: 'user', content: 'continue' },
            ],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'continued' } },
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    let writes = 0;
    const tools: AgentToolRuntime = {
      listDefinitions: () => [
        {
          name: 'write',
          description: 'write once',
          inputSchema: { type: 'object' },
          access: 'write',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      execute: async () => {
        writes += 1;
        return { ok: true, data: 'committed' };
      },
    };
    const transport = new LocalGeneralAgentTransport({
      driver,
      tools,
      clock,
      createId: (kind) => `${kind}-write-history`,
    });
    const events: AgentEventEnvelope[] = [];
    let abortIssued = false;
    transport.subscribeEvents((event) => {
      events.push(event);
      if (
        !abortIssued &&
        event.turnId === 'turn-write' &&
        event.event.type === 'tool_result' &&
        event.event.ok
      ) {
        abortIssued = true;
        void transport.abort();
      }
    });

    await transport.start({
      prompt: 'write once',
      turnId: 'turn-write',
      route: { kind: 'chat', projectId: 'project-1', conversationId: 'conversation-1' },
    });
    await waitForDone(events, 1);
    const session = events.find(
      (event) => event.turnId === 'turn-write' && event.event.type === 'session',
    );
    if (session?.event.type !== 'session') throw new Error('missing write session');

    await transport.start({
      prompt: 'continue',
      turnId: 'turn-continue',
      resume: session.event.id,
      route: { kind: 'chat', projectId: 'project-1', conversationId: 'conversation-1' },
    });
    await waitForDone(events, 2);

    expect(abortIssued).toBe(true);
    expect(writes).toBe(1);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('uses installed auth status and disables unsupported provider reasoning', async () => {
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = {
      id: 'no-reasoning',
      capabilities: { reasoning: false },
      async *stream(request) {
        requests.push(request);
        yield { type: 'usage', usage: USAGE };
        yield { type: 'finish', reason: 'end_turn' };
      },
    };
    const transport = new LocalGeneralAgentTransport({
      driver,
      authStatus: async () => ({
        byokConnected: true,
        apiKeyConnected: true,
        hostedAvailable: false,
      }),
      createId: (kind) => `${kind}-capabilities`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    await expect(transport.authStatus()).resolves.toEqual({
      ok: true,
      value: {
        byokConnected: true,
        apiKeyConnected: true,
        hostedAvailable: false,
      },
    });
    await expect(
      transport.start({
        prompt: 'inspect',
        route: { kind: 'chat', projectId: 'project-1' },
        thinking: 'adaptive',
        effort: 'max',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.reasoning).toEqual({ enabled: false });
  });

  it('rejects invalid routes and treats a post-restart session id as a resume hint', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            messages: [{ role: 'user', content: 'unknown resume' }],
          },
          steps: [
            { op: 'emit', event: { type: 'usage', usage: USAGE } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const transport = new LocalGeneralAgentTransport({
      driver,
      createId: (kind) => `${kind}-route`,
    });
    const events: AgentEventEnvelope[] = [];
    transport.subscribeEvents((event) => events.push(event));

    await expect(transport.start({ prompt: 'missing' })).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_ROUTE_REQUIRED',
    });
    await expect(
      transport.start({
        prompt: 'mismatch',
        projectId: 'project-a',
        route: { kind: 'chat', projectId: 'project-b' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_ROUTE_REQUIRED',
    });
    await expect(
      transport.start({
        prompt: 'unknown resume',
        resume: 'missing-session',
        route: { kind: 'chat', projectId: 'project-a' },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await waitForDone(events, 1);
    expect(driver.calls).toHaveLength(1);
    driver.assertExhausted();
  });
});
