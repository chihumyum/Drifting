import { describe, expect, it } from 'vitest';

import { createSanitizedDiagnosticSummary } from './sanitized-summary';

describe('sanitized diagnostic summary', () => {
  it('exports counts and safe codes without identifiers, content, paths, or raw errors', () => {
    const summary = createSanitizedDiagnosticSummary({
      generatedAt: '2026-08-20T00:00:00.000Z',
      runtime: {
        appInfo: { name: 'Drifting', version: '0.1.0-alpha.1', platform: 'macos', architecture: 'aarch64' },
        capabilities: null,
        target: 'desktop',
        nativePlatform: 'macos',
        deviceClass: 'desktop',
        shellMode: 'desktop',
        isMobile: false,
        isMobileShell: false,
        isExpandedTablet: false,
        isMacDesktop: true,
        desktopWindowControls: true,
      },
      authority: {
        loaded: true,
        status: 'cloud-attention',
        mode: 'google-drive',
        targetMode: null,
        transitionKind: null,
        generation: 2,
        activeSyncGenerations: 1,
        readySyncGenerations: 0,
        provisioningSyncGenerations: 0,
        pausedSyncGenerations: 0,
        attentionSyncGenerations: 1,
        errorCode: '/private/writer/private manuscript',
      },
      sync: {
        mounted: true,
        syncGenerationIds: ['private-generation-id'],
        diagnostics: {
          generatedAtMs: 1,
          activeSyncGenerationId: 'private-generation-id',
          online: false,
          suspended: false,
          generations: [{
            syncGenerationId: 'private-generation-id',
            phase: 'idle',
            cycleNumber: 3,
            lastPullSuccessAtMs: null,
            lastPublishSuccessAtMs: null,
            lastConvergedAtMs: null,
            lastOutcome: 'failed',
            lastFailedPhase: 'pulling',
            lastErrorCode: 'rate-limited',
            pending: {
              pendingChangeSets: 1,
              pendingSegments: 2,
              pendingTransfers: 3,
              openGaps: 4,
              openConflicts: 5,
              quarantinedObjects: 6,
            },
          }],
        },
      },
      update: {
        phase: 'error',
        update: null,
        downloadedBytes: 0,
        totalBytes: null,
        error: 'failed at /private/writer/secret',
      },
      googleDriveOperationTraces: [
        {
          operation: 'disconnect-google-drive',
          startedAt: '2026-08-20T00:00:00.000Z',
          status: 'failed',
          durationMs: 125,
          events: [
            {
              offsetMs: 125,
              layer: 'ios-google-sign-in',
              phase: 'disconnect-revoke-request',
              outcome: 'failed',
              code: 'transient',
              native: {
                schemaVersion: 1,
                operation: 'revoke',
                platform: 'ios',
                phase: 'disconnect-revoke-request',
                elapsedMs: 125,
                completedPhases: ['revoke-request-started'],
                errorChain: [{
                  family: 'network', domain: 'ns-url', code: -1001,
                  reason: 'timeout', httpStatus: null,
                }],
              },
            },
          ],
        },
      ],
    });

    expect(summary).toContain('"formatVersion": 2');
    expect(summary).toContain('"rate-limited"');
    expect(summary).toContain('"redacted-error"');
    expect(summary).toContain('"transfers": 3');
    expect(summary).not.toContain('private-generation-id');
    expect(summary).not.toContain('/private/writer');
    expect(summary).not.toContain('private manuscript');
    expect(summary).toContain('"phase": "disconnect-revoke-request"');
    expect(summary).toContain('"domain": "ns-url"');
    expect(summary).toContain('"code": -1001');
    expect(summary).toContain('"rawErrorTextIncluded": false');
  });
});
