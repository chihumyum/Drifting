import { describe, expect, it } from 'vitest';
import {
  AgentRuntimePersistenceConflictError,
  assertAgentRuntimeEventSequence,
  canonicalAgentRuntimeJson,
  classifyAgentRuntimeEventReplay,
} from './agent-runtime-persistence-repo';

describe('agent runtime persistence repository invariants', () => {
  it('canonicalizes nested object keys without changing array order', () => {
    expect(
      canonicalAgentRuntimeJson({
        z: 1,
        route: { projectId: '项目-🪶', kind: 'chat' },
        blocks: [{ text: '第一章', type: 'text' }, '尾声'],
        a: true,
      }),
    ).toBe(
      '{"a":true,"blocks":[{"text":"第一章","type":"text"},"尾声"],"route":{"kind":"chat","projectId":"项目-🪶"},"z":1}',
    );
    expect(canonicalAgentRuntimeJson({ b: 2, a: 1 })).toBe(
      canonicalAgentRuntimeJson({ a: 1, b: 2 }),
    );
  });

  it.each([
    { value: { bad: undefined }, message: 'unsupported undefined' },
    { value: { bad: Number.NaN }, message: 'non-finite number' },
    { value: { bad: Number.POSITIVE_INFINITY }, message: 'non-finite number' },
    { value: { bad: BigInt(1) }, message: 'unsupported bigint' },
  ])('rejects non-portable payload: $message', ({ value }) => {
    expect(() => canonicalAgentRuntimeJson(value)).toThrow(
      AgentRuntimePersistenceConflictError,
    );
  });

  it('rejects cyclic payloads instead of truncating recovery state', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalAgentRuntimeJson(cyclic)).toThrow(/cycle/);
  });

  it('accepts only the exact next event sequence', () => {
    expect(() =>
      assertAgentRuntimeEventSequence('turn-1', 1, null),
    ).not.toThrow();
    expect(() =>
      assertAgentRuntimeEventSequence('turn-1', 8, 7),
    ).not.toThrow();
  });

  it('treats an identical eventId replay as idempotent but rejects payload drift', () => {
    const event = {
      eventId: 'turn-1:00000001',
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 1,
      schemaVersion: 1,
      eventType: 'turn_started',
      payload: { route: { kind: 'chat', projectId: 'project-1' } },
      wallTimeMs: 42,
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const payloadJson = canonicalAgentRuntimeJson(event.payload);
    const existing = { ...event, payloadJson };

    expect(
      classifyAgentRuntimeEventReplay(existing, event, payloadJson),
    ).toBe('duplicate');
    expect(() =>
      classifyAgentRuntimeEventReplay(
        { ...existing, payloadJson: '{"different":true}' },
        event,
        payloadJson,
      ),
    ).toThrow(/different content/);
  });

  it('rejects sequence gaps and occupied sequence numbers with stable codes', () => {
    try {
      assertAgentRuntimeEventSequence('turn-1', 3, 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'EVENT_SEQ_GAP' });
    }

    try {
      assertAgentRuntimeEventSequence('turn-1', 2, 2, 'turn-1:00000002');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'EVENT_SEQ_CONFLICT' });
    }
  });
});
