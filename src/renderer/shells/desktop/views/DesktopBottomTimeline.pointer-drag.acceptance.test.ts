import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const bottomTimeline = readFileSync(new URL('./DesktopBottomTimeline.tsx', import.meta.url), 'utf8');
const storyGraph = readFileSync(new URL('./DesktopStoryGraphView.tsx', import.meta.url), 'utf8');
const storyGraphLane = readFileSync(
  new URL('../../../features/graph/StoryGraphLaneRow.tsx', import.meta.url),
  'utf8',
);
const storyGraphUnplaced = readFileSync(
  new URL('../../../features/graph/StoryGraphUnplacedChapters.tsx', import.meta.url),
  'utf8',
);
const sharedDrag = readFileSync(
  new URL('../../../features/graph/chapter-lane-drag.ts', import.meta.url),
  'utf8',
);

describe('desktop chapter pointer drag acceptance', () => {
  it('commits a continuous Bottom Timeline coordinate without per-frame React state', () => {
    expect(bottomTimeline).toContain('const startNodePointerDrag = (');
    expect(bottomTimeline).toContain(
      'onPointerDown={(event) => startNodePointerDrag(event, node, storylineId)}',
    );
    expect(bottomTimeline).toContain(
      'storylineId === DEFAULT_LANE_ID || storylineId === UNAFFILIATED_LANE_ID',
    );
    expect(bottomTimeline).toContain('(!fromDrawer && !isSyntheticLane');
    expect(bottomTimeline).not.toContain(
      'if (event.button !== 0 || primaryStorylineId(node) !== storylineId) return;',
    );
    expect(bottomTimeline).toContain('await commitChapterLaneDrop({');
    expect(bottomTimeline).toContain('const grabOffsetX = chapterLaneGrabOffsetX(');
    expect(bottomTimeline).toContain('resolveChapterLanePointerTarget({');
    expect(bottomTimeline).not.toContain('setDragOverPosition');
    expect(bottomTimeline).not.toContain('left: liveLeftPosition,');
    expect(bottomTimeline).not.toContain('chapterInsertionIndexForDrop');
    expect(bottomTimeline).not.toContain('moveChapterToIndex');
  });

  it('uses the same pointer path for holding chips and Storyline Graph tiles', () => {
    expect(bottomTimeline).toContain('{ fromDrawer: true }');
    expect(storyGraph).toContain('const startGraphChapterPointerDrag = useCallback((');
    expect(storyGraph).toContain('startChapterLanePointerDrag({');
    expect(storyGraph).toContain('resolveChapterLanePointerTarget({');
    expect(storyGraphLane).toContain('data-storyline-row={lane.id}');
    expect(storyGraphLane).toContain('data-node-container');
    expect(storyGraphLane).toContain('onPointerDown={(event) => onNodePointerDown(event, node)}');
    expect(storyGraph).toContain('onNodePointerDown={handleChapterPointerDown}');
    expect(storyGraph).toContain("const handleChapterPointerDown = useCallback<StoryGraphLaneRowProps['onNodePointerDown']>");
    expect(storyGraphUnplaced).toContain('onPointerDown={(event) => onNodePointerDown(event, node)}');
    expect(storyGraph).toContain('onNodePointerDown={handleUnplacedPointerDown}');
    expect(storyGraph).toContain("const handleUnplacedPointerDown = useCallback<StoryGraphUnplacedChaptersProps['onNodePointerDown']>");
    expect(storyGraph).toContain(
      'if (!mobileLinkMode) startGraphChapterPointerDrag(event, node);',
    );
    expect(storyGraph).toContain('{ fromDrawer: true }');
    expect(storyGraph).toContain('chapterLaneGrabOffsetX(event.clientX, sourceRect)');
    expect(storyGraph).not.toContain('initializeChapterDrag');
    expect(storyGraph).not.toContain('handleTileDragStart');
    expect(storyGraph).not.toContain('handleTracksDragOver');
    expect(storyGraph).not.toContain('handleTracksDrop');
  });

  it('moves one full-style compositor ghost and locks selection during drag', () => {
    expect(sharedDrag).toContain("cloneNode(true)");
    expect(sharedDrag).toContain("sourceElement.style.visibility = 'hidden'");
    expect(sharedDrag).toContain('window.requestAnimationFrame(paintDrag)');
    expect(sharedDrag).toContain('translate3d(');
    expect(sharedDrag).toContain("classList.add('chapter-lane-pointer-dragging')");
    expect(sharedDrag).toContain('window.getSelection()?.removeAllRanges()');
    expect(sharedDrag).not.toContain('chapter-lane-pointer-indicator');
    expect(sharedDrag).not.toContain('sourceRect.width / 2');
    expect(sharedDrag).not.toContain('setState');
  });
});
