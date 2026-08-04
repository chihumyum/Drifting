import { useEffect } from 'react';
import { events } from '../lib/events';
import { useNotificationStore } from '../store/notification-store';

/**
 * Wires the global `ai-task` event stream emitted by Copilot into the
 * notification store. Mounted once in App
 * (always present) so task history is collected regardless of whether the topbar
 * pill is rendered on this platform.
 */
export function useNotificationFeed(): void {
  useEffect(() => {
    const ingest = useNotificationStore.getState().ingest;
    events.on('ai-task', ingest);
    return () => events.off('ai-task', ingest);
  }, []);
}
