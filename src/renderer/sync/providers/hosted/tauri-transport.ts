import { APP_CONFIG } from '../../../lib/config';
import { getHostedSessionBinding } from '../../../lib/hosted-session-binding';
import { platform } from '../../../platform';
import {
  HostedObjectLogProvider,
  type HostedNamespace,
  type HostedObjectTransport,
} from './provider';
export class HostedTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'HostedTransportError';
  }
}
export class TauriHostedObjectTransport implements HostedObjectTransport {
  accountSubject = () => getHostedSessionBinding()?.accountSubject ?? null;
  async request(input: Parameters<HostedObjectTransport['request']>[0]): Promise<unknown> {
    const binding = getHostedSessionBinding();
    if (!binding) throw new HostedTransportError('needs-reauth', false);
    try {
      return await platform.hostedSync.request({
        ...input,
        origin: APP_CONFIG.API_BASE_URL,
        token: binding.token,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const codes = [
        'needs-reauth',
        'permission-denied',
        'rate-limited',
        'provider-unavailable',
        'IMMUTABLE_OBJECT_CONFLICT',
        'HASH_MISMATCH',
        'SIZE_MISMATCH',
        'REMOTE_OBJECT_MISSING',
        'REMOTE_STORE_CORRUPT',
        'ABORTED',
      ];
      const code = codes.find((value) => detail.includes(value)) ?? 'provider-unavailable';
      if (code === 'needs-reauth') {
        await (await import('../../../store/auth')).useAuthStore.getState().expireSession(binding.token);
        const current = getHostedSessionBinding();
        if (current && current.token !== binding.token)
          throw new HostedTransportError('provider-unavailable', true);
      }
      throw new HostedTransportError(code, ['provider-unavailable', 'rate-limited'].includes(code));
    }
  }
}
export function createHostedProvider(
  namespace: HostedNamespace = 'project-v1',
): HostedObjectLogProvider {
  return new HostedObjectLogProvider(new TauriHostedObjectTransport(), namespace);
}
