import { describe, expect, it } from 'vitest';

import { AgentRuntimeAbortError } from '../errors';
import type {
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../types';
import { ManualAgentClock } from './manual-agent-clock';
import {
  ScriptedFakeDriver,
  ScriptedFakeDriverError,
} from './scripted-fake-driver';

function request(
  signal: AbortSignal,
  overrides: Partial<AgentModelRequest> = {},
): AgentModelRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    iteration: 1,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxOutputTokens: 512,
    signal,
    ...overrides,
  };
}

async function collect(
  stream: AsyncIterable<AgentModelStreamEvent>,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('ScriptedFakeDriver', () => {
  it('records immutable request snapshots and emits scripted rounds', async () => {
    const messages: AgentModelRequest['messages'] = [{ role: 'user', content: 'original' }];
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            iteration: 1,
            messages: [{ role: 'user', content: 'original' }],
            toolNames: ['read_chapter'],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'done' } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const controller = new AbortController();
    const stream = driver.stream(
      request(controller.signal, {
        messages,
        tools: [
          {
            name: 'read_chapter',
            description: 'read',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );
    messages[0] = { role: 'user', content: 'mutated later' };

    await expect(collect(stream)).resolves.toEqual([
      { type: 'text_delta', text: 'done' },
      { type: 'finish', reason: 'end_turn' },
    ]);
    expect(driver.calls).toEqual([
      expect.objectContaining({
        messages: [{ role: 'user', content: 'original' }],
        tools: [
          {
            name: 'read_chapter',
            description: 'read',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    ]);
    expect(Object.isFrozen(driver.calls[0])).toBe(true);
    driver.assertExhausted();
  });

  it('supports observable gates, early release credits, and abort', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'wait', gate: 'provider-ready' },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
        {
          steps: [{ op: 'wait', gate: 'abort-here' }],
        },
      ],
    });

    driver.release('provider-ready');
    const firstController = new AbortController();
    await expect(collect(driver.stream(request(firstController.signal)))).resolves.toEqual([
      { type: 'finish', reason: 'end_turn' },
    ]);
    await driver.waitUntilGate('provider-ready');

    const secondController = new AbortController();
    const iterator = driver.stream(
      request(secondController.signal, { iteration: 2 }),
    )[Symbol.asyncIterator]();
    const next = iterator.next();
    await driver.waitUntilGate('abort-here');
    secondController.abort('test abort');

    await expect(next).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentRuntimeAbortError',
        message: 'test abort',
      }),
    );
    driver.assertExhausted();
  });

  it('uses the injected clock and reports incomplete scripts', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({
      clock,
      rounds: [
        {
          name: 'delayed finish',
          steps: [
            { op: 'sleep', ms: 25 },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const controller = new AbortController();
    const iterator = driver.stream(request(controller.signal))[Symbol.asyncIterator]();
    const next = iterator.next();

    expect(clock.pendingSleepCount).toBe(1);
    expect(() => driver.assertExhausted()).toThrow(ScriptedFakeDriverError);
    clock.advanceBy(24);
    expect(clock.pendingSleepCount).toBe(1);
    clock.advanceBy(1);
    await expect(next).resolves.toEqual({
      done: false,
      value: { type: 'finish', reason: 'end_turn' },
    });
    await iterator.next();
    driver.assertExhausted();
  });
});

describe('ManualAgentClock', () => {
  it('settles equal deadlines in insertion order and removes aborted sleeps', async () => {
    const clock = new ManualAgentClock({ wallTimeMs: 1_000, monotonicTimeMs: 50 });
    const order: string[] = [];
    const abortController = new AbortController();

    const late = clock.sleep(10, abortController.signal).then(
      () => order.push('late'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(AgentRuntimeAbortError);
        order.push('aborted');
      },
    );
    const first = clock.sleep(5).then(() => order.push('first'));
    const second = clock.sleep(5).then(() => order.push('second'));

    clock.advanceBy(5);
    await Promise.resolve();
    expect(order).toEqual(['first', 'second']);
    expect(clock.wallNowMs()).toBe(1_005);
    expect(clock.monotonicNowMs()).toBe(55);

    abortController.abort('cancel sleep');
    await Promise.all([late, first, second]);
    expect(order).toEqual(['first', 'second', 'aborted']);
    clock.assertIdle();
  });

  it('drains chained sleeps and permits an independent backwards wall-clock jump', async () => {
    const clock = new ManualAgentClock({ wallTimeMs: 10_000, monotonicTimeMs: 0 });
    const work = (async () => {
      await clock.sleep(10);
      await clock.sleep(20);
    })();

    await expect(clock.runUntilIdle()).resolves.toBe(2);
    await work;
    expect(clock.monotonicNowMs()).toBe(30);
    expect(clock.wallNowMs()).toBe(10_030);

    clock.advanceWallBy(-5_000);
    expect(clock.wallNowMs()).toBe(5_030);
    expect(clock.monotonicNowMs()).toBe(30);
  });
});
