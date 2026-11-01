import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  commitSurface,
  stopPageTurn,
  turnPage,
} from '../../../components/editor/editor-page-turn';
import {
  editorStageWaiting,
  setEditorStageWaiting,
} from '../../../components/editor/editor-stage-waiting';
import { PAGE_BLEND_EASING, PAGE_BLEND_MS } from '../../../lib/motion';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

interface FakeAnimation {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  cancel(): void;
  finished: Promise<unknown>;
}

/** A surface that records the animations started on it; its style is its computed style. */
function fakeSurface() {
  const animations: FakeAnimation[] = [];
  const surface = {
    style: { opacity: '1', transform: 'none' },
    animations,
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: FakeAnimation = {
        frames,
        options,
        cancelled: false,
        cancel() { this.cancelled = true; },
        finished: new Promise(() => undefined),
      };
      animations.push(animation);
      return animation;
    },
  };
  return surface;
}
const asElement = (surface: ReturnType<typeof fakeSurface>) => surface as unknown as HTMLElement;

describe('the paper turns to another page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns only once the book is in view, leaving the replaced surface shown', () => {
    const home = { revisionKey: 'project-home' };
    const chapter = { revisionKey: 'node:a' };
    const opened = commitSurface({ committed: null, leaving: null }, home, false);
    expect(opened).toEqual({ committed: home, leaving: null });
    // While the book opens under the sea (or under reduced motion) it just swaps.
    expect(commitSurface(opened, chapter, false)).toEqual({ committed: chapter, leaving: null });
    const turning = commitSurface(opened, chapter, true);
    expect(turning).toEqual({ committed: chapter, leaving: home });
    // The same page reporting ready again keeps its turn going.
    const again = { revisionKey: 'node:a' };
    expect(commitSurface(turning, again, true)).toEqual({ committed: again, leaving: home });
  });

  it('dissolves the next page in over the one in front, which stays whole underneath', () => {
    vi.stubGlobal('getComputedStyle', (element: { style: unknown }) => element.style);
    const incoming = fakeSurface();
    const outgoing = fakeSurface();
    const dissolve = turnPage(asElement(incoming), asElement(outgoing)) as unknown as FakeAnimation;

    expect(dissolve).toBe(incoming.animations[0]);
    // In place: only opacity changes, nothing moves.
    expect(dissolve.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(dissolve.options).toEqual({ duration: PAGE_BLEND_MS, easing: PAGE_BLEND_EASING });
    // The page underneath is left alone, so the ink on the paper never thins.
    expect(outgoing.animations).toHaveLength(0);

    // Going straight back: the page that was arriving rests whole underneath,
    // and the one coming back starts from the share of the paper it still had.
    incoming.style.opacity = '0.7';
    turnPage(asElement(outgoing), asElement(incoming));
    expect(dissolve.cancelled).toBe(true);
    expect(incoming.animations).toHaveLength(1);
    expect(outgoing.animations[0].frames[0].opacity).toBeCloseTo(0.3);
    expect(outgoing.animations[0].frames[1]).toEqual({ opacity: 1 });

    stopPageTurn(asElement(outgoing));
    expect(outgoing.animations[0].cancelled).toBe(true);
  });

  it('keeps the stage the owner of the turn and the wait', () => {
    const main = source('src/renderer/components/editor/EditorMainArea.tsx');
    expect(main).toContain('const turn = stageAnnounced.current && !prefersReducedMotion();');
    // The paper stays under both pages while they turn: no desk shows through.
    expect(main).toContain("style={{ position: 'relative', height: '100%', width: '100%', background: 'hsl(var(--page))' }}");
    expect(main).toContain('turnPage(incoming, outgoing).finished.then(settle, () => undefined);');
    expect(main).toContain('stopPageTurn(surfaceOf(previous));');
    expect(main).toContain("zIndex: isVisible ? 2 : isLeaving ? 1 : 0,");
    expect(main).toContain('if (leavingSurface && !next.some((surface) => surface.revisionKey === leavingSurface.revisionKey)) {');
    // Only the turns it started are ever cancelled.
    expect(main).not.toMatch(/getAnimations\(/u);
    expect(source('src/renderer/components/editor/editor-page-turn.ts')).not.toMatch(/getAnimations\(/u);
    expect(main).toContain('const timer = setTimeout(() => setEditorStageWaiting(activeTabKey), LOADING_DELAY_MS);');
  });
});

describe('the dock tab asked for drifts while its page is prepared', () => {
  afterEach(() => setEditorStageWaiting(null));

  it('names one waiting tab at a time', () => {
    expect(editorStageWaiting()).toBeNull();
    setEditorStageWaiting('node:a');
    expect(editorStageWaiting()).toBe('node:a');
    setEditorStageWaiting('node:b');
    expect(editorStageWaiting()).toBe('node:b');
    setEditorStageWaiting(null);
    expect(editorStageWaiting()).toBeNull();
  });

  it('draws the wait as drifting glass on the pill, or on the dot while the dock is folded', () => {
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    expect(timeline).toContain('const waitingTabKey = useEditorStageWaiting();');
    expect(timeline).toContain("${isLoading ? ' glass--loading' : ''}");
    expect(timeline).toContain("${isLoading ? ' glass glass--round glass--loading' : ''}");
    const materials = source('src/styles/materials.css');
    expect(materials).toContain('.glass.glass--loading::before {');
    expect(materials).toContain('animation: glass-flow var(--motion-glass-loading) linear infinite running;');
    expect(materials).toContain('.glass.glass--loading::before,\n  .glass-sweep.glass--rest::before,');
    const shell = source('src/styles/desktop-shell.css');
    expect(shell).toContain('.workspace-tab-dock .app-tab-dot.glass--loading::before {');
  });
});
