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
    expect(generalAgentTransport.subscribeEvents(vi.fn())).toMatchObject({
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
      subscribeEvents: () => ({ ok: true, value: () => undefined }),
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
});
