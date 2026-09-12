// Isolated browser-fixture replacement for the status seam only. The real
// queue, SQLite and commit wiring are exercised by the integration suites.
const errors = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();
export const retries: string[] = [];
export function getProjectReferenceIndexSnapshot(projectId: string) {
  return { hasError: errors.get(projectId) ?? false };
}
export function subscribeProjectReferenceIndex(projectId: string, listener: () => void) {
  const subscribers = listeners.get(projectId) ?? new Set();
  listeners.set(projectId, subscribers);
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export function retryProjectReferenceIndex(projectId: string) { retries.push(projectId); }
export function publish(projectId: string, failed: boolean) {
  errors.set(projectId, failed);
  for (const listener of listeners.get(projectId) ?? []) listener();
}
export function subscriptions(projectId: string) { return listeners.get(projectId)?.size ?? 0; }
