import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

export type MobilePaperRail = 'toc' | 'comments';

export interface MobilePaperRailAvailability {
  toc: boolean;
  comments: boolean;
}

export function mobilePaperRailAvailability(
  target: WorkspaceTarget | null,
): MobilePaperRailAvailability {
  if (!target || target.entityType === 'dashboard') return { toc: false, comments: false };
  if (target.entityType === 'all-chapters') return { toc: true, comments: false };
  return { toc: true, comments: true };
}

export function toggleMobilePaperRail(
  current: MobilePaperRail | null,
  requested: MobilePaperRail,
): MobilePaperRail | null {
  return current === requested ? null : requested;
}

export function mobilePaperRailFromCommentVisibility(
  current: MobilePaperRail | null,
  commentsVisible: boolean,
  commentsAvailable: boolean,
): MobilePaperRail | null {
  if (!commentsAvailable) return current;
  if (commentsVisible) return 'comments';
  return current === 'comments' ? null : current;
}
