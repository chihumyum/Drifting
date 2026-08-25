import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');
const document = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Mobile panel handle and shared Stats correction', () => {
  it('gives a moving panel one visible handle owner and hides competing chrome', () => {
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const panels = source('shells/mobile/workspace/MobileWorkspacePanels.tsx');
    const bar = source('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const handle = source('shells/mobile/workspace/MobilePanelPullHandle.tsx');
    const css = document('src/styles/mobile-workspace.css');

    expect(deck).toContain('data-preview={panelResizing');
    expect(deck).toContain('data-panel-drag-source={panelDragSource');
    expect(deck).toContain('onPanelDragStateChange={setPanelDragState}');
    expect(panels).toContain('variant="boundary"');
    expect(panels).not.toContain('PanelResizeHandle');
    expect(bar).toContain('onDragStateChange={onPanelDragStateChange}');
    expect(handle).toContain("type PanelHandleVariant = 'entry' | 'boundary'");
    expect(css).toContain(".m-workspace[data-preview='true'] .m-unified-bar");
    expect(css).toContain(".m-workspace[data-full-panel='bottom'] .m-unified-bar");
    expect(css).toContain(".m-workspace:not([data-reveal='focused'])");
    expect(css).toContain("[data-panel-drag-source='bottom'] .m-unified-bar");
  });

  it('preserves ordinary drag extent and reserves full screen for edge or fling', () => {
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const gesture = source('shells/mobile/workspace/mobile-panel-gesture.ts');

    expect(deck).toContain('resolveMobilePanelGesture(gesture)');
    expect(deck).not.toContain('extent >= 0.5');
    expect(gesture).toContain('FULL_EDGE = 0.985');
    expect(gesture).toContain('FLING_TRAVEL = 0.12');
    expect(gesture).toContain("return { state: 'docked', extent }");
  });

  it('moves Stats out of the bottom rail and reuses the shared desktop content', () => {
    const panels = source('shells/mobile/workspace/MobileWorkspacePanels.tsx');
    const sheet = source('shells/mobile/workspace/MobilePaperStatsSheet.tsx');
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');

    expect(panels).toContain("type ToolTab = 'planning' | 'agent' | 'library'");
    expect(panels).not.toContain("| 'stats'");
    expect(sheet).toContain("from '../../../features/stats/EntityStatsContent'");
    expect(sheet).toContain('<EntityStatsContent');
    expect(sheet).toContain('offset >= 96 || velocity >= 0.75');
    expect(controller).toContain("{ kind: 'paper-stats' }");
  });

});
