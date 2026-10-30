import { describe, expect, it } from 'vitest';
import { chooseSuperView, type SuperViewStage } from './super-view-stage-model';
import { SUPER_VIEW_OPTIONS, type SuperViewId } from './super-view-options';

const ORDER = SUPER_VIEW_OPTIONS.map((option) => option.id);
const closed: SuperViewStage<SuperViewId> = { shown: null, behind: [], push: null };
const choose = (stage: SuperViewStage<SuperViewId>, next: SuperViewId | null) => chooseSuperView(stage, next, ORDER);

describe('chooseSuperView', () => {
  it('follows the switcher left to right: element, graph, then TODO and library', () => {
    expect(ORDER).toEqual(['element', 'graph', 'memo-material']);
  });

  it('opens and closes without a push', () => {
    const open = choose(closed, 'graph');
    expect(open).toEqual({ shown: 'graph', behind: [], push: null });
    expect(choose(open, null)).toEqual(closed);
    expect(choose(open, 'graph')).toBe(open);
  });

  it('pushes toward the side the new view lies on in the switcher', () => {
    const graph = choose(closed, 'graph');
    // The library lies to the right: it enters from the right, pushing left.
    expect(choose(graph, 'memo-material')).toEqual({
      shown: 'memo-material', behind: ['graph'], push: { id: 1, dir: -1 },
    });
    // The element overview lies to the left: it enters from the left, pushing right.
    expect(choose(graph, 'element')).toEqual({
      shown: 'element', behind: ['graph'], push: { id: 1, dir: 1 },
    });
  });

  it('keeps every view still on the strip when switching mid-push, and pulls one back', () => {
    const first = choose(choose(closed, 'element'), 'graph');
    const second = choose(first, 'memo-material');
    expect(second).toEqual({ shown: 'memo-material', behind: ['element', 'graph'], push: { id: 2, dir: -1 } });
    const back = choose(second, 'graph');
    expect(back).toEqual({ shown: 'graph', behind: ['element', 'memo-material'], push: { id: 3, dir: 1 } });
  });

  it('drops the views pushed away when the Super View closes mid-push', () => {
    const pushing = choose(choose(closed, 'element'), 'graph');
    expect(choose(pushing, null)).toEqual(closed);
  });
});
