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
  statuses.set(projectId, { ...statuses.get(projectId), ...value });
  for (const listener of listeners) listener();
}
