export type WorkspaceEntityType =
  | 'node'
  | 'storyline'
  | 'element'
  | 'category'
  | 'library_item'
  | 'all-chapters';

// Tab bar glyph, shared with lists that name a target (Review groups). For
// node entities the caller passes isDrift so chapters (§) can be told from
// drift nodes (❦ — matches the "构想" button in LeftSidebarHeader).
export function workspaceTargetGlyph(entityType: WorkspaceEntityType, opts?: { isDrift?: boolean }): string {
  switch (entityType) {
    case 'node':
      return opts?.isDrift ? '❦' : '§';
    case 'storyline':
      return '¶';
    case 'element':
      return '◆';
    case 'category':
      return '⌘';
    case 'library_item':
      return '❏';
    case 'all-chapters':
      return '☰';
  }
}

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
  showProjectHome(options?: { replace?: boolean }): void;
  leaveDeletedTarget(): void;
}
