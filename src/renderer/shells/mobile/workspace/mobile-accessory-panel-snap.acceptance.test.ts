import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');
const document = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Mobile format-level toggle and panel close snap correction', () => {
  it('changes only the accessory level when the Format label is clicked', () => {
    const accessory = source('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');

    expect(accessory).toContain('data-debug-id="mobile-toggle-formatting"');
    expect(accessory).toMatch(
      /const toggle = \(event: ReactMouseEvent<HTMLButtonElement>\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?\? 'navigation' : 'formatting'/u,
    );
    expect(accessory).toContain('onClick={toggle}');
    expect(bar).toContain("{projection.mode === 'edit' && (");
    expect(bar).toContain('data-debug-id="mobile-dismiss-keyboard"');
  });

  it('uses one 72px close snap zone for top and bottom panel handles', () => {
    const gesture = source('shells/mobile/workspace/mobile-panel-gesture.ts');
    const handle = source('shells/mobile/workspace/MobilePanelPullHandle.tsx');

    expect(gesture).toContain('const CLOSE_SNAP_PX = 72');
    expect(gesture).toContain('CLOSE_SNAP_PX / Math.max(1, gesture.viewportHeightPx)');
    expect(gesture).toContain('if (extent <= closeEdge)');
    expect(handle.match(/viewportHeightPx: Math\.max\(1, window\.innerHeight\)/g)).toHaveLength(2);
  });

  it('keeps the product contract and Simulator evidence attached', () => {
    const editing = document('docs/mobile-v2/editing-comments-search-and-all-chapters.md');
    const panels = document('docs/mobile-v2/unified-bar-rails-and-paper-swipe.md');
    const evidence = document(
      'docs/qa/mobile-v2-format-toggle-panel-snap-simulator-2026-08-25.md',
    );

    expect(editing).toContain('explicit keyboard-dismiss control');
    expect(panels).toContain('Releases at 72 CSS pixels');
    expect(evidence).toContain('inputPath=synthetic-dom');
    expect(evidence).toContain('physical-device continuous touch remains open');
  });
});
