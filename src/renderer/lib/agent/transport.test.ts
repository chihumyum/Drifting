import { describe, expect, it, vi } from 'vitest';
import {
  GENERAL_AGENT_UNSUPPORTED,
  generalAgentTransport,
  installGeneralAgentTransport,
  type GeneralAgentTransport,
} from './transport';

describe('General Agent transport boundary', () => {
  it('reports every unsupported operation as an explicit error', async () => {
    const results = await Promise.all([
      generalAgentTransport.authPrepare(),
      generalAgentTransport.authSubmitCode('code'),
      generalAgentTransport.authStatus(),
      generalAgentTransport.authLogout(),
      generalAgentTransport.start({ prompt: 'test' }),
      generalAgentTransport.resolvePermission({
        requestId: 'permission-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        argumentsHash: `sha256:${'0'.repeat(64)}`,
        revision: null,
        decision: 'deny',
        scope: 'once',
      }),
      generalAgentTransport.submitUserInput({
        requestId: 'input-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        text: 'answer',
      }),
      generalAgentTransport.steer({ turnId: 'turn-1', text: 'change course' }),
      generalAgentTransport.stopAfterTool({ turnId: 'turn-1' }),
      generalAgentTransport.listPendingControls({ sessionId: 'session-1' }),
      generalAgentTransport.cancelPendingControl({
        sessionId: 'session-1',
        turnId: 'turn-1',
        requestId: 'permission-1',
      }),
      generalAgentTransport.abort(),
      generalAgentTransport.resetSession(),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        code: GENERAL_AGENT_UNSUPPORTED.code,
        error: GENERAL_AGENT_UNSUPPORTED.message,
      });
    }
    expect(generalAgentTransport.subscribeJournal(vi.fn())).toMatchObject({
      ok: false,
      code: GENERAL_AGENT_UNSUPPORTED.code,
    });
  });

  it('keeps a replaceable sidecar/remote seam', async () => {
    const start = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const transport: GeneralAgentTransport = {
      capability: { available: true, kind: 'remote' },
      authPrepare: async () => ({ ok: true, value: { url: 'https://example.invalid' } }),
      authSubmitCode: async () => ({ ok: true, value: undefined }),
      authStatus: async () => ({
        ok: true,
        value: { byokConnected: true, apiKeyConnected: false, hostedAvailable: false },
      }),
      authLogout: async () => ({ ok: true, value: undefined }),
      start,
      resolvePermission: async () => ({ ok: true, value: undefined }),
      submitUserInput: async () => ({ ok: true, value: undefined }),
      steer: async () => ({ ok: true, value: undefined }),
      stopAfterTool: async () => ({ ok: true, value: undefined }),
      listPendingControls: async () => ({ ok: true, value: [] }),
      cancelPendingControl: async () => ({ ok: true, value: undefined }),
      abort: async () => ({ ok: true, value: undefined }),
      resetSession: async () => ({ ok: true, value: undefined }),
      subscribeJournal: () => ({ ok: true, value: () => undefined }),
    };
    const restore = installGeneralAgentTransport(transport);
    try {
      expect(generalAgentTransport.capability.kind).toBe('remote');
      expect(await generalAgentTransport.start({ prompt: 'hello' })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(start).toHaveBeenCalledWith({ prompt: 'hello' });
    } finally {
      restore();
    }
    expect(generalAgentTransport.capability.kind).toBe('unsupported');
  });

  it('moves existing stream subscriptions across transport replacement', () => {
    const journalA = new Set<(entry: never) => void>();
    const journalB = new Set<(entry: never) => void>();
    const transport = (
      journal: Set<(entry: never) => void>,
      kind: 'local' | 'remote',
    ): GeneralAgentTransport => ({
      capability: { available: true, kind },
      authPrepare: async () => ({ ok: true, value: { url: 'https://example.invalid' } }),
      authSubmitCode: async () => ({ ok: true, value: undefined }),
      authStatus: async () => ({
        ok: true,
        value: { byokConnected: true, apiKeyConnected: false, hostedAvailable: false },
      }),
      authLogout: async () => ({ ok: true, value: undefined }),
      start: async () => ({ ok: true, value: undefined }),
      resolvePermission: async () => ({ ok: true, value: undefined }),
      submitUserInput: async () => ({ ok: true, value: undefined }),
      steer: async () => ({ ok: true, value: undefined }),
      stopAfterTool: async () => ({ ok: true, value: undefined }),
      listPendingControls: async () => ({ ok: true, value: [] }),
      cancelPendingControl: async () => ({ ok: true, value: undefined }),
      abort: async () => ({ ok: true, value: undefined }),
      resetSession: async () => ({ ok: true, value: undefined }),
      subscribeJournal: (callback) => {
        journal.add(callback as (entry: never) => void);
        return {
          ok: true,
          value: () => journal.delete(callback as (entry: never) => void),
        };
      },
    });
    const first = transport(journalA, 'local');
    const second = transport(journalB, 'remote');
    const restoreFirst = installGeneralAgentTransport(first);
    const onJournal = vi.fn();
    const journalSubscription = generalAgentTransport.subscribeJournal(onJournal);
    expect(journalSubscription.ok).toBe(true);
    const restoreSecond = installGeneralAgentTransport(second);
    try {
      expect(journalA.size).toBe(0);
      expect(journalB.size).toBe(1);

      restoreSecond();
      expect(journalA.size).toBe(1);
      expect(journalB.size).toBe(0);
    } finally {
      if (journalSubscription.ok) journalSubscription.value();
      restoreSecond();
      restoreFirst();
    }
    expect(journalA.size).toBe(0);
  });
});
