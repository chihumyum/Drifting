import type { MarkdownProjectionInfo } from '../platform/contracts';

export type MarkdownProjectionStatus = Partial<MarkdownProjectionInfo> & {
  state: 'pending' | 'ready' | 'error';
  error?: string;
};
const statuses = new Map<string, MarkdownProjectionStatus>();
const listeners = new Set<() => void>();

export function getMarkdownProjectionStatus(projectId: string): MarkdownProjectionStatus | undefined {
  return statuses.get(projectId);
}
export function subscribeMarkdownProjectionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishMarkdownProjectionStatus(projectId: string, value: MarkdownProjectionStatus) {
  // An undefined field clears it. Drop the key: the status is returned by
  // get_project_overview, and durable Agent payloads reject undefined.
  const next: Record<string, unknown> = { ...statuses.get(projectId), ...value };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  statuses.set(projectId, next as MarkdownProjectionStatus);
  for (const listener of listeners) listener();
}
