import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  binding: { accountSubject: 'synthetic', token: 'old' } as {
    accountSubject: string;
    token: string;
  } | null,
  request: vi.fn(),
  expire: vi.fn(),
}));
vi.mock('../../../lib/config', () => ({
  APP_CONFIG: { API_BASE_URL: 'https://synthetic.example.test' },
}));
vi.mock('../../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => mocks.binding,
}));
vi.mock('../../../platform', () => ({ platform: { hostedSync: { request: mocks.request } } }));
vi.mock('../../../store/auth', () => ({
  useAuthStore: { getState: () => ({ expireSession: mocks.expire }) },
}));
import { TauriHostedObjectTransport } from './tauri-transport';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.binding = { accountSubject: 'synthetic', token: 'old' };
});
describe('Hosted sync credential rotation', () => {
  it('retries a stale rejection without expiring or blocking the newly rotated session', async () => {
    mocks.request.mockImplementation(async () => {
      mocks.binding = { accountSubject: 'synthetic', token: 'new' };
      throw new Error('needs-reauth');
    });
    await expect(
      new TauriHostedObjectTransport().request({
        method: 'GET',
        path: '/api/sync/v1/project-v1/snapshots',
      }),
    ).rejects.toMatchObject({ code: 'provider-unavailable', retryable: true });
    expect(mocks.expire).toHaveBeenCalledWith('old');
  });
  it('still stops sync when the currently bound credential is rejected', async () => {
    mocks.request.mockRejectedValue(new Error('needs-reauth'));
    mocks.expire.mockImplementation(async () => {
      mocks.binding = null;
    });
    await expect(
      new TauriHostedObjectTransport().request({
        method: 'GET',
        path: '/api/sync/v1/project-v1/snapshots',
      }),
    ).rejects.toMatchObject({ code: 'needs-reauth', retryable: false });
  });
});
