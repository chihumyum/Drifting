import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {
    onmessage: (event: unknown) => void;

    constructor(onmessage: (event: unknown) => void) {
      this.onmessage = onmessage;
      tauriMocks.channels.push(this);
    }
  },
  convertFileSrc: vi.fn(),
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('../lib/config', () => ({
  APP_CONFIG: { API_BASE_URL: 'http://localhost:3000' },
  canUseExternalContent: () => false,
  canUseHostedService: () => false,
}));

import { GoogleDrivePlatformError, tauriPlatform } from './tauri';

describe('Tauri native Google Drive platform boundary', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.channels.length = 0;
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  it('unwraps native metadata without exposing credentials, sessions, or filesystem paths', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'google_drive_open_generation') {
        return {
          ok: true,
          value: {
            generationRef: 'syncdrive:generation-a',
            syncGenerationId: 'generation-a',
          },
        };
      }
      if (command === 'google_drive_capture_start_cursor') {
        return { ok: true, value: 'cursor-a' };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      tauriPlatform.googleDrive.openGeneration({
        credentialSecretRef: 'sync.google-drive.credentials.opaque',
        accountSubject: 'google-subject',
        bindingId: 'binding-a',
        syncGenerationId: 'generation-a',
        authorityGeneration: 1,
      }),
    ).resolves.toEqual({
      generationRef: 'syncdrive:generation-a',
      syncGenerationId: 'generation-a',
    });
    await expect(
      tauriPlatform.googleDrive.captureStartCursor('syncdrive:generation-a'),
    ).resolves.toBe('cursor-a');
    const calls = JSON.stringify(tauriMocks.invoke.mock.calls);
    expect(calls).not.toMatch(/accessToken|refreshToken|bearer|sessionUri|filePath|\/Users\//u);
  });

  it('preserves retry classification and Retry-After without returning an upstream body', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: 'rate-limited',
        message: 'Google Drive rate limit was reached',
        retryable: true,
        retryAfterMs: 17_000,
        diagnostics: {
          schemaVersion: 1,
          operation: 'revoke',
          platform: 'ios',
          phase: 'disconnect-revoke-request',
          elapsedMs: 20,
          completedPhases: ['revoke-request-started'],
          errorChain: [{
            family: 'network', domain: 'ns-url', code: -1001,
            reason: 'timeout', httpStatus: null,
          }],
        },
      },
    });

    const error = await tauriPlatform.googleDrive
      .listInventory({ generationRef: 'syncdrive:generation-a' })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoogleDrivePlatformError);
    expect(error).toMatchObject({
      code: 'rate-limited',
      retryable: true,
      retryAfterMs: 17_000,
      diagnostics: {
        phase: 'disconnect-revoke-request',
        errorChain: [{ domain: 'ns-url', code: -1001 }],
      },
    });
  });

  it('revokes through native using only the opaque credential reference', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'google_drive_revoke_account') {
        return { ok: true, value: { status: 'already-revoked' } };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      tauriPlatform.googleDrive.revokeAccount('sync.google-drive.credentials.opaque'),
    ).resolves.toBeUndefined();

    const [, args] = tauriMocks.invoke.mock.calls.find(
      ([command]) => command === 'google_drive_revoke_account',
    )!;
    expect(args).toEqual({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      transferId: expect.stringMatching(/^revoke-/u),
    });
    expect(JSON.stringify(args)).not.toMatch(/accessToken|refreshToken|bearer/u);
  });

  it('reauthorizes the same opaque credential ref entirely in native code', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'google_drive_oauth_reauthorize') {
        return {
          ok: true,
          value: {
            credentialSecretRef: 'sync.google-drive.credentials.opaque',
            accountSubject: 'google-subject',
          },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      tauriPlatform.googleDrive.reauthorizeAccount('sync.google-drive.credentials.opaque'),
    ).resolves.toEqual({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('google_drive_oauth_reauthorize', {
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toMatch(
      /accessToken|refreshToken|bearer/u,
    );
  });

  it('claims a provisional native credential only by opaque ref and account subject', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'google_drive_claim_account') {
        return {
          ok: true,
          value: {
            credentialSecretRef: 'sync.google-drive.credentials.opaque',
            accountSubject: 'google-subject',
          },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      tauriPlatform.googleDrive.claimAccount(
        'sync.google-drive.credentials.opaque',
        'google-subject',
      ),
    ).resolves.toEqual({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('google_drive_claim_account', {
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toMatch(
      /accessToken|refreshToken|bearer/u,
    );
  });

  it('projects a native same-account violation as account-mismatch', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: 'account-mismatch',
        message: 'Google reauthorization selected a different account',
        retryable: false,
        retryAfterMs: null,
      },
    });

    await expect(
      tauriPlatform.googleDrive.reauthorizeAccount('sync.google-drive.credentials.opaque'),
    ).rejects.toMatchObject({
      code: 'account-mismatch',
      retryable: false,
    });
  });

  it('cancels an in-flight native revoke without exposing a public transfer ID', async () => {
    let finishRevoke!: (value: unknown) => void;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === 'google_drive_revoke_account') {
        return new Promise((resolve) => {
          finishRevoke = resolve;
        });
      }
      if (command === 'google_drive_cancel_transfer') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });

    const controller = new AbortController();
    const pending = tauriPlatform.googleDrive.revokeAccount(
      'sync.google-drive.credentials.opaque',
      controller.signal,
    );
    controller.abort();
    finishRevoke({ ok: true, value: { status: 'revoked' } });

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const revokeArgs = tauriMocks.invoke.mock.calls.find(
      ([command]) => command === 'google_drive_revoke_account',
    )?.[1] as { transferId: string };
    expect(tauriMocks.invoke).toHaveBeenCalledWith('google_drive_cancel_transfer', {
      transferId: revokeArgs.transferId,
    });
  });

  it('cancels a native transfer by opaque transfer ID when AbortSignal fires', async () => {
    let finishUpload!: (value: unknown) => void;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === 'google_drive_upload_immutable') {
        return new Promise((resolve) => {
          finishUpload = resolve;
        });
      }
      if (command === 'google_drive_cancel_transfer') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });
    const controller = new AbortController();
    const pending = tauriPlatform.googleDrive.uploadImmutable({
      generationRef: 'syncdrive:generation-a',
      sourceRef: 'syncobj:staged-object',
      objectKind: 'segment',
      logicalKeyId: `sha256:${'a'.repeat(64)}`,
      storedSha256: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 42,
      transferId: 'transfer-a',
      signal: controller.signal,
    });
    controller.abort();
    finishUpload({
      ok: true,
      value: {
        status: 'created',
        object: {
          objectId: 'drive-file-a',
          objectKind: 'segment',
          logicalKeyId: `sha256:${'a'.repeat(64)}`,
          storedSha256: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 42,
        },
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('google_drive_cancel_transfer', {
      transferId: 'transfer-a',
    });
  });

  it('streams sanitized byte progress through a transfer-local channel', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== 'google_drive_upload_immutable') {
        throw new Error(`unexpected command: ${command}`);
      }
      const channel = args.onProgress as { onmessage: (event: unknown) => void };
      channel.onmessage({
        transferId: 'transfer-progress',
        direction: 'upload',
        transferredBytes: 8,
        totalBytes: 42,
      });
      return {
        ok: true,
        value: {
          status: 'created',
          object: {
            objectId: 'drive-file-progress',
            objectKind: 'segment',
            logicalKeyId: `sha256:${'a'.repeat(64)}`,
            storedSha256: `sha256:${'b'.repeat(64)}`,
            sizeBytes: 42,
          },
        },
      };
    });
    const progress = vi.fn();

    await tauriPlatform.googleDrive.uploadImmutable({
      generationRef: 'syncdrive:generation-a',
      sourceRef: 'syncobj:staged-object',
      objectKind: 'segment',
      logicalKeyId: `sha256:${'a'.repeat(64)}`,
      storedSha256: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 42,
      transferId: 'transfer-progress',
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(progress).toHaveBeenCalledWith({
      transferId: 'transfer-progress',
      direction: 'upload',
      transferredBytes: 8,
      totalBytes: 42,
    });
    expect(tauriMocks.channels).toHaveLength(1);
  });
});
