export type MemoResolution = 'no_action' | 'unresolved' | 'resolved';

export type MemoPriority = 'low' | 'med' | 'high';

export interface Memo {
  id: string;
  projectId: string;
  title: string;
  bodyJson: string;
  resolution: MemoResolution;
  priority: MemoPriority | null;
  dueAt: string | null;
  orderKey: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
