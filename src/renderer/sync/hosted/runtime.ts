import { canUseHostedService } from '../../lib/config';
import { getDb, getDbIfInitialized } from '../../lib/db';
import { events } from '../../lib/events';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { platform } from '../../platform';
import { useAuthStore } from '../../store/auth';
import { SyncGenerationProvisionSupervisor } from '../provision/supervisor';
import { discoverHostedProjects } from './connect';

let requestDiscovery: (() => void) | null = null;
let discoverySupervisor: SyncGenerationProvisionSupervisor | null = null;
export async function holdHostedDiscovery(): Promise<() => void> {
  return discoverySupervisor ? discoverySupervisor.hold() : () => {};
}
export function requestHostedDiscovery(): void {
  requestDiscovery?.();
}

export function installHostedDiscoveryRuntime(): () => void {
  const supervisor = new SyncGenerationProvisionSupervisor({
    canUseProvider: () =>
      getDbIfInitialized() !== null && canUseHostedService() && getHostedSessionBinding() !== null,
    async runOnce(signal) {
      const session = getHostedSessionBinding();
      if (!session) return;
      await discoverHostedProjects(getDb(), signal);
    },
    onError(error) {
      console.warn('[Hosted] Project discovery will retry', error);
    },
  });
  const request = () => supervisor.requestRun();
  discoverySupervisor = supervisor;
  const refresh = () => {
    void useAuthStore.getState().refreshHostedSession().then(request);
  };
  const wake = () => {
    if (useAuthStore.getState().hostedStatus === 'offline') refresh();
    else request();
  };
  requestDiscovery = wake;
  events.on('db:ready', request);
  events.on('sync:authority-changed', request);
  globalThis.addEventListener?.('online', refresh);
  const unsubscribeResume = platform.lifecycle.onReadyOrResume(refresh);
  globalThis.addEventListener?.('focus', wake);
  const timer = globalThis.setInterval(wake, 30_000);
  return () => {
    globalThis.clearInterval(timer);
    unsubscribeResume();
    globalThis.removeEventListener?.('online', refresh);
    globalThis.removeEventListener?.('focus', wake);
    events.off('db:ready', request);
    events.off('sync:authority-changed', request);
    if (requestDiscovery === request) requestDiscovery = null;
    supervisor.stop();
    if (discoverySupervisor === supervisor) discoverySupervisor = null;
  };
}
