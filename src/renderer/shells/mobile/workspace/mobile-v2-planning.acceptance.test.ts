import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

// Mobile planning = the desktop coordinate system turned vertical (timeline)
// plus one shared Plot Grid table filling the paper tool. This wiring test
// pins the reuse boundary: coordinates, writers, drag controller and gesture
// table are the desktop modules; only presentation and the entry projection
// are mobile-owned.
describe('Mobile V2 Planning acceptance wiring', () => {
  it('mounts the vertical timeline on the shared coordinate system', () => {
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const timeline = source('shells/mobile/workspace/timeline/MobileVerticalTimeline.tsx');
    const selectors = source('components/BottomTimeline/useBottomTimelineSelectors.ts');
    const desktop = source('shells/desktop/views/DesktopBottomTimeline.tsx');

    expect(deck).toContain('<MobileVerticalTimeline');
    expect(deck).not.toContain('<BottomTimeline presentation="mobile" />');
    // Coordinates and writers are shared, not re-implemented.
    expect(timeline).toContain('useBottomTimelineSelectors({');
    expect(timeline).toContain('positionToOrder');
    expect(selectors).toContain('const positionToOrder = useCallback(');
    expect(desktop).toContain('positionToOrder,\n  } = useBottomTimelineSelectors({');
    expect(timeline).toContain('spreadTimelineNodes({');
    expect(timeline).toContain('deriveActSegments(');
    expect(timeline).toContain('useTimelineMarkers(projectId)');
    expect(timeline).toContain('commitChapterLaneDrop({');
    expect(timeline).toContain('startChapterLanePointerDrag({');
    expect(timeline).toContain("orderField: 'bookOrder' | 'narrativeOrder'");
    // The mobile shell never reaches the desktop navigation store.
    expect(timeline).not.toContain('store/ui-store');
  });

  it('projects entries from the dots and keeps every gesture in the track gutter', () => {
    const timeline = source('shells/mobile/workspace/timeline/MobileVerticalTimeline.tsx');
    const projection = source('shells/mobile/workspace/timeline/vertical-timeline-projection.ts');
    const gestures = source('shells/mobile/workspace/timeline/vertical-timeline-gestures.ts');
    const drag = source('features/graph/chapter-lane-drag.ts');
    const gesture = source('features/graph/mobile-planning-gesture.ts');
    const scale = source('components/BottomTimeline/useTimelineExpandedScale.ts');

    // Dots at orderToPosition; entries are a pure projection with leaders and clusters.
    expect(timeline).toContain('projectVerticalTimeline(items, { minTop: 8 })');
    expect(projection).toContain("L: { minGap: 120, height: 110 }");
    expect(projection).toContain("X: { minGap: 0, height: 24 }");
    expect(projection).toContain('VERTICAL_TIMELINE_CLUSTER_RUN = 3');
    expect(projection).toContain('leader: { fromY: item.y, toY: top + anchor }');
    expect(timeline).toContain('<svg className="m-vtl__leads"');
    // Gestures: gutter long-press lifts the nearest dot by y; entries only tap.
    expect(timeline).toContain('onPointerDown={onGutterPointerDown}');
    expect(timeline).toContain('nearestVerticalDot(dotCandidates, y, VERTICAL_TIMELINE_DOT_HIT_PX)');
    expect(gestures).toContain('VERTICAL_TIMELINE_DOT_HIT_PX = 22');
    expect(timeline).toContain("holdBehavior: 'lift'");
    expect(timeline).toContain("axis: 'y'");
    expect(timeline).not.toContain('className="m-vtl__ent-body"\n                  onPointerDown');
    expect(drag).toContain("holdBehavior?: 'menu' | 'lift'");
    expect(drag).toContain("autoscrollAxis === 'y'");
    expect(gesture).toContain('MOBILE_PLANNING_DRAG_ARM_MS = 180');
    expect(gesture).toContain('MOBILE_PLANNING_CONTEXT_MENU_MS = 500');
    expect(timeline).toContain('startVerticalHandleDrag({');
    // Pinch anchors the vertical scroll axis with its own persisted scale.
    expect(scale).toContain("axis?: TimelineScaleAxis");
    expect(scale).toContain('timelinePinchAnchoredScrollOffset({');
    expect(timeline).toContain("storageKey: VERTICAL_SCALE_STORAGE_KEY");
    // Narrative view keeps the unplaced chapters in a drawer whose chips drag out.
    expect(timeline).toContain('className="m-vtl__tray');
    expect(timeline).toContain('onPointerDown={(event) => startChipDrag(event, node.id)}');
    // Menus ride the tool overlay as popover transients so Back closes them first.
    expect(timeline).toContain("MOBILE_TIMELINE_SHEET_TRANSIENT_ID = 'tool:timeline-sheet'");
  });

  it('keeps Planning out of paper swipe and gives Plot Grid its filled table and explicit moves', () => {
    const swipe = source('shells/mobile/workspace/mobile-paper-swipe.ts');
    const grid = source('components/editor/PlotGrid.tsx');
    const draft = source('components/editor/plot-grid/usePlotGridDraft.ts');
    const layout = source('components/editor/plot-grid/plot-grid-layout.ts');
    const tools = source('shells/mobile/workspace/MobilePaperTools.tsx');
    const sheets = source('shells/mobile/workspace/MobilePlotSheets.tsx');
    const domain = source('domain/plot-grid.ts');
    const writer = source('usecase/plot-grid-write.ts');
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(swipe).toContain("'.planner-wrap'");
    expect(swipe).toContain("'.m-vtl'");
    expect(swipe).toContain("'.m-plot'");
    // One shared table: fill rules, transposed view, header menu, no corner grip.
    expect(layout).toContain("mobile: { minCellW: 84, minCellH: 72");
    expect(layout).toContain('export function plotGridView(');
    expect(grid).toContain('resolvePlotGridLayout({');
    expect(grid).toContain('onPaste={(e) => handlePaste(cell, e)}');
    expect(grid).not.toContain('onGripDown');
    expect(draft).toContain("move(axis: PlotGridDataAxis, id: string, delta: -1 | 1): boolean;");
    expect(domain).toContain("readonly type: 'row.move'");
    expect(domain).toContain("readonly type: 'column.move'");
    expect(writer).toContain("case 'row.move'");
    expect(writer).toContain("case 'column.move'");
    // Mobile: header owns orientation + quick add; cells edit in a sheet above the keyboard.
    expect(tools).toContain('<PlotGridEditor');
    expect(tools).toContain("localStorage.setItem(TRANSPOSED_STORAGE_KEY");
    expect(tools).toContain("api?.addVisual('row')");
    expect(sheets).toContain('export function MobilePlotCellSheet');
    expect(sheets).toContain('export function MobilePlotHeaderSheet');
    expect(sheets).toContain('keyboardAware');
    expect(controller).toContain("state.transient.id === 'tool:plot-cell'");
    expect(css).toContain('.m-plot__orientation');
    expect(css).toContain('.m-sheet__panel');
    expect(css).toContain('.m-vtl__leads polyline');
  });
});
