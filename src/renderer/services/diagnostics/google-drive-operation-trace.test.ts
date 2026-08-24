import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginGoogleDriveDisconnectTrace,
  clearGoogleDriveOperationTracesForTests,
  finishGoogleDriveDisconnectTrace,
  getSanitizedGoogleDriveOperationTraces,
  recordGoogleDriveTraceEvent,
} from './google-drive-operation-trace';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('Google Drive operation trace', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    clearGoogleDriveOperationTracesForTests();
  });

  it('persists a bounded call chain without an exported trace identifier', () => {
    for (let index = 0; index < 4; index += 1) {
      const traceId = beginGoogleDriveDisconnectTrace();
      recordGoogleDriveTraceEvent(traceId, {
        layer: 'renderer-disconnect',
        phase: 'read-authority',
        outcome: 'passed',
      });
      finishGoogleDriveDisconnectTrace(traceId, 'succeeded');
    }

    const traces = getSanitizedGoogleDriveOperationTraces();
    expect(traces).toHaveLength(3);
    expect(traces[0]).toMatchObject({
      operation: 'disconnect-google-drive',
      status: 'succeeded',
      events: [{ layer: 'renderer-disconnect', phase: 'read-authority' }],
    });
    expect(JSON.stringify(traces)).not.toContain('traceId');
  });

  it('records only allowlisted native fields and drops arbitrary error text', () => {
    const traceId = beginGoogleDriveDisconnectTrace();
    finishGoogleDriveDisconnectTrace(
      traceId,
      'failed',
      Object.assign(new Error('token private-user@example.com /Users/example/private/manuscript'), {
        code: 'transient',
        diagnostics: {
          schemaVersion: 1,
          operation: 'revoke',
          platform: 'ios',
          phase: 'disconnect-revoke-request',
          elapsedMs: 123,
          completedPhases: ['sdk-configured', 'revoke-request-started'],
          errorChain: [
            {
              family: 'network',
              domain: 'ns-url',
              code: -1001,
              reason: 'timeout',
              httpStatus: null,
            },
          ],
        },
      }),
    );

    const serialized = JSON.stringify(getSanitizedGoogleDriveOperationTraces());
    expect(serialized).toContain('disconnect-revoke-request');
    expect(serialized).toContain('ns-url');
    expect(serialized).toContain('-1001');
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('/Users/example/private');
    expect(serialized).not.toContain('token ');
  });

  it('rejects native diagnostic strings outside the token grammar', () => {
    const traceId = beginGoogleDriveDisconnectTrace();
    finishGoogleDriveDisconnectTrace(traceId, 'failed', {
      code: 'transient',
      diagnostics: {
        schemaVersion: 1,
        operation: 'revoke',
        platform: 'ios',
        phase: '/private/path',
        elapsedMs: 1,
        completedPhases: [],
        errorChain: [],
      },
    });

    const [trace] = getSanitizedGoogleDriveOperationTraces();
    expect(trace.events[trace.events.length - 1]).toMatchObject({
      layer: 'rust-native',
      phase: 'disconnect-failed',
      code: 'transient',
    });
    expect(JSON.stringify(trace)).not.toContain('/private/path');
  });
});
