import { describe, expect, it } from 'vitest';
import type { WorkspaceTarget } from './workspace-target';
import {
  isProjectHomePathname,
  workspaceTargetFromPathname,
  workspaceUrlFor,
} from './workspace-route';

describe('workspace route mapping', () => {
  it.each<WorkspaceTarget>([
    { entityType: 'node', id: 'node-1' },
    { entityType: 'storyline', id: 'storyline-1' },
    { entityType: 'element', id: 'element-1' },
    { entityType: 'category', id: '人物 / 主要' },
    { entityType: 'all-chapters', id: 'self' },
  ])('round-trips $entityType targets between a shell session and the URL', (target) => {
    const url = workspaceUrlFor('project-1', target);
    expect(url).not.toBeNull();
    expect(workspaceTargetFromPathname('project-1', url!)).toEqual(target);
  });

  it('does not interpret the project root or a sibling project as a paper target', () => {
    expect(workspaceTargetFromPathname('project-1', '/project/project-1')).toBeNull();
    expect(workspaceTargetFromPathname('project-1', '/project/project-1/home')).toBeNull();
    expect(
      workspaceTargetFromPathname('project-1', '/project/project-10/editor/node-1'),
    ).toBeNull();
  });

  it('identifies only the exact project root as Project Home', () => {
    expect(isProjectHomePathname('project-1', '/project/project-1')).toBe(true);
    expect(isProjectHomePathname('project-1', '/project/project-1/')).toBe(true);
    expect(isProjectHomePathname('project-1', '/project/project-1/editor/node-1')).toBe(false);
    expect(isProjectHomePathname('project-1', '/project/project-10')).toBe(false);
  });
});
