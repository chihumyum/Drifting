import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '../protocol';
import { LocalGeneralAgentTransport } from './local-transport';
import { ManualAgentClock, ScriptedFakeDriver } from './testing';
import type { AgentToolRuntime } from './types';

const USAGE = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

async function waitForDone(
  events: AgentEventEnvelope[],
  count: number,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (events.filter((event) => event.event.type === 'done').length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} done event(s)`);
}

describe('LocalGeneralAgentTransport', () => {
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
      'usage',
      'error',
      'done',
    ]);
    expect(events[2].event).toEqual({
      type: 'error',
      message: 'Agent journal persistence failed',
    });
    expect(events.filter((event) => event.event.type === 'done')).toHaveLength(1);
    driver.assertExhausted();
    clock.assertIdle();
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
            expect(request.systemPrompt).toContain('Chinese');
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
      writingLanguage: 'Chinese',
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

  it('rejects missing or conflicting routes before calling a driver', async () => {
    const driver = new ScriptedFakeDriver({ rounds: [] });
    const transport = new LocalGeneralAgentTransport({
      driver,
      createId: (kind) => `${kind}-route`,
    });

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
    ).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_SESSION_NOT_AVAILABLE',
    });
    expect(driver.calls).toHaveLength(0);
    driver.assertExhausted();
  });
});
