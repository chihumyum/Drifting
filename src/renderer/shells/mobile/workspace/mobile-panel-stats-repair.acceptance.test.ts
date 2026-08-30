import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Shared Stats correction', () => {
  it('moves Stats out of the bottom rail and reuses the shared desktop content', () => {
    const face = source('shells/mobile/workspace/MobileRightSidebar.tsx');
    const sheet = source('shells/mobile/workspace/MobilePaperStatsSheet.tsx');
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');

    expect(face).toContain("type ToolTab = 'planning' | 'review' | 'agent' | 'library'");
    expect(face).not.toContain("| 'stats'");
    expect(sheet).toContain("from '../../../features/stats/EntityStatsContent'");
    expect(sheet).toContain('<EntityStatsContent');
    expect(sheet).toContain('offset >= 96 || velocity >= 0.75');
    expect(controller).toContain("{ kind: 'paper-stats' }");
  });

});
