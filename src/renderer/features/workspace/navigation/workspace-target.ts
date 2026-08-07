export type WorkspaceEntityType =
  | 'node'
  | 'storyline'
  | 'element'
  | 'category'
  | 'dashboard'
  | 'all-chapters';

/** Shell-neutral description of content the user wants to open. */
export interface WorkspaceTarget {
  entityType: WorkspaceEntityType;
  id: string;
}

/**
 * Shared features may request navigation through this contract without
 * knowing whether the target is rendered in a desktop tab or a mobile stack.
 */
export interface WorkspaceNavigator {
  projectId: string;
  open(target: WorkspaceTarget, options?: { preview?: boolean }): void;
  activate(target: WorkspaceTarget): void;
  leaveDeletedTarget(): void;
}
