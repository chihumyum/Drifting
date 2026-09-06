import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('continuous Bottom Timeline authority', () => {
  it('keeps timeline coordinates authored without rewriting the SQLite baseline', () => {
    const schema = source('src/renderer/schema/drizzle.ts');
    expect(schema).toContain("bookOrder: integer('book_order')");
    expect(schema).toContain("narrativeOrder: integer('narrative_order')");

    const manifest = source('src/renderer/sync/protocol/domain-manifest.ts');
    expect(manifest).toMatch(/'authored',[\s\S]*?'book_order',[\s\S]*?'narrative_order'/u);
    expect(manifest).toMatch(/table: 'book_act'[\s\S]*?'authored',[\s\S]*?'start_order'/u);

    const fieldPolicy = source('src/renderer/sync/reducer/production-domain-kernel.ts');
    expect(fieldPolicy).toContain('bookOrder: NULLABLE_FINITE_NUMBER');
    expect(fieldPolicy).toContain("'book-act': {");
    expect(fieldPolicy).toContain('startOrder: NULLABLE_FINITE_NUMBER');
  });

  it('does not create fractional chapter or act-list authority', () => {
    const orderAuthority = source('src/renderer/sync/journal/order-authority.ts');
    expect(orderAuthority).not.toMatch(/^\s*'chapter',\s*$/mu);
    expect(orderAuthority).not.toMatch(/^\s*'book-act',\s*$/mu);

    for (const writer of [
      'src/renderer/usecase/book-node-write.ts',
      'src/renderer/usecase/useBookNode.ts',
      'src/renderer/usecase/useBookAct.ts',
    ]) {
      expect(source(writer), writer).not.toContain('appendPlannedAuthoredOrderInTransaction');
    }
  });

  it('keeps exact coordinates in chapter, act, Agent and restore wire payloads', () => {
    expect(source('src/renderer/usecase/useBookNode.ts')).toContain(
      'bookOrder: newNode.bookOrder',
    );
    expect(source('src/renderer/usecase/useBookAct.ts')).toContain(
      'startOrder: act.startOrder',
    );
    expect(source('src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts'))
      .toContain('bookOrder: value.bookOrder');
    expect(source('src/renderer/usecase/sync-lifecycle-restore.ts')).toContain(
      'bookOrder: node.bookOrder',
    );
  });

  it('uses one atomic command for coordinate and storyline membership on drop', () => {
    const command = source('src/renderer/usecase/chapter-timeline-move.ts');
    expect(command).toContain('return withAtomicSyncTransaction(input.projectId');
    expect(command).toContain("await sync('node', 'update'");
    expect(command).toContain('await linkRepo.setNodeStorylines(');
    expect(command).toContain('await appendAuthoredNodeStorylineProjectionInTransaction(');

    const bottomTimeline = source(
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
    );
    expect(bottomTimeline).toContain('{ fromDrawer: true }');
    expect(bottomTimeline).not.toContain('initializeChapterDrag');
    expect(bottomTimeline).not.toContain('onDragStart=');
  });

  it('keeps empty axes actionable and marker/act movement continuous', () => {
    const bottomTimeline = source(
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
    );
    // The continuous inverse mapping now lives beside orderToPosition in the
    // shared selectors so the vertical mobile axis reuses it unchanged.
    const selectors = source('src/renderer/components/BottomTimeline/useBottomTimelineSelectors.ts');
    expect(selectors).toContain('const positionToOrder = useCallback(');
    expect(bottomTimeline).toContain('positionToOrder,\n  } = useBottomTimelineSelectors({');
    expect(bottomTimeline).not.toContain('disabled={snapValues.length === 0}');

    const timelinePin = source('src/renderer/components/timeline/TimelinePin.tsx');
    expect(timelinePin).toContain('nextOrder = positionToOrder(startPixel + dx)');
    expect(timelinePin).not.toContain('snapValues');

    const actRail = source('src/renderer/components/BottomTimeline/ActRail.tsx');
    expect(actRail).toContain('xToOrder(startPixel + dx)');
    expect(actRail).not.toContain('snapOrders');
    expect(actRail).not.toContain('Math.round(xToOrder');
  });

  it('keeps empty marker and act rails context-menu actionable', () => {
    const bottomTimeline = source(
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
    );
    const storyGraph = source(
      'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
    );
    const actRail = source('src/renderer/components/BottomTimeline/ActRail.tsx');

    expect(bottomTimeline).toContain('onContextMenuCapture={');
    expect(bottomTimeline).toContain('markers.length === 0');
    expect(storyGraph).toContain('markers.length === 0');
    expect(actRail).toContain("segments.length === 0 ? ' actrail--empty' : ''");
    expect(actRail).not.toContain('if (segments.length === 0) {');
    expect(actRail).toContain("if (menu.kind === 'rail')");
  });

  it('makes the first act a movable boundary and preserves a no-act book head', () => {
    const usecase = source('src/renderer/usecase/useBookAct.ts');
    const domain = source('src/renderer/domain/book-act.ts');
    const actRail = source('src/renderer/components/BottomTimeline/ActRail.tsx');
    const bottomTimeline = source(
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
    );
    const storyGraph = source(
      'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
    );

    expect(usecase).not.toContain('const opener: BookAct');
    expect(usecase).not.toContain('createdActs.push(opener)');
    expect(usecase).toContain('await repoTx.create(act)');
    expect(domain).toContain('let si = -1;');
    expect(domain).toContain('if (si >= 0)');
    expect(actRail).toContain('const currentOrder = act.startOrder ?? axisMinOrder;');
    expect(actRail).toContain('left edge of every act, including the first');
    expect(bottomTimeline).toContain('bookActs.length === 0 ? minOrder');
    expect(storyGraph).toContain('bookActs.length === 0 ? orderSpan.min');
  });
});
