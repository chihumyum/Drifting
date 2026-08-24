import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('desktop create-tab return ownership', () => {
  it('normalizes Project Home ownership before activating the create draft', () => {
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const createClick = timeline.slice(
      timeline.indexOf('aria-label={t(\'topTimeline.newEntity\')}'),
      timeline.indexOf('{contextMenu &&'),
    );

    expect(timeline).toContain('isProjectHomePathname(projectId, location.pathname)');
    expect(createClick.indexOf('setActiveTab(projectId, null);')).toBeGreaterThanOrEqual(0);
    expect(createClick.indexOf('setActiveTab(projectId, null);')).toBeLessThan(
      createClick.indexOf('openCreateTab(projectId);'),
    );
    expect(createClick.indexOf('openCreateTab(projectId);')).toBeLessThan(
      createClick.indexOf('navigate(`/project/${projectId}/new`);'),
    );
  });
});
