import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { SuperViewLeavingContext } from '../../components/super-view-leaving';
import { trackGlassFlow } from '../../lib/glass-flow';
import { PUSH_EASING, PUSH_MS, PUSH_OUTLINE_FADE_MS } from '../../lib/motion';
import { planSidebarPush } from '../../lib/sidebar-push';
import { SUPER_VIEW_OPTIONS, type SuperViewId } from './super-view-options';
import { chooseSuperView, type SuperViewStage } from './super-view-stage-model';
import {
  DeferredElementGraphView,
  DeferredMemoMaterialView,
  DeferredStoryGraphView,
} from './views/DeferredSuperViews';

const VIEWS: Record<SuperViewId, ComponentType> = {
  element: DeferredElementGraphView,
  graph: DeferredStoryGraphView,
  'memo-material': DeferredMemoMaterialView,
};
const ORDER: readonly SuperViewId[] = SUPER_VIEW_OPTIONS.map((option) => option.id);

// The push on each element a switch moved, so a later switch cancels only
// these and never a view's own CSS animations or transitions.
const pushes = new WeakMap<Element, Animation>();

function cancelPush(element: Element) {
  pushes.get(element)?.cancel();
  pushes.delete(element);
}

/**
 * Push one element along `frames`, from `at` into the push when it joins
 * late. The arriving block (`settle`) ends without a transform, so the fixed
 * layers inside it place against the window again.
 */
function startPush(part: HTMLElement, frames: Keyframe[], settle: boolean, at?: CSSNumberish | null) {
  cancelPush(part);
  const animation = part.animate(frames, { duration: PUSH_MS, easing: PUSH_EASING, fill: 'forwards' });
  if (at != null) animation.currentTime = at;
  pushes.set(part, animation);
  if (settle) {
    animation.finished.then(() => {
      if (pushes.get(part) === animation) cancelPush(part);
    }, () => {});
  }
  return animation;
}

function overlayOf(slide: HTMLElement | undefined) {
  return slide?.querySelector<HTMLElement>('.super-view-overlay') ?? null;
}

/** Everything a view shows except its header: the block a switch pushes. */
function pushedParts(slide: HTMLElement | undefined): HTMLElement[] {
  const overlay = overlayOf(slide);
  if (!overlay) return [];
  return [...overlay.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && !child.classList.contains('super-view-head'));
}

/** How far a view's block is pushed right now, running pushes included. */
function pushedX(slide: HTMLElement | undefined) {
  const part = pushedParts(slide)[0];
  const transform = part ? getComputedStyle(part).transform : 'none';
  return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0;
}

/**
 * The open Super View. Switching to another pushes the open view's block
 * (everything under its header) away like heavy ice, the way a sidebar pane
 * switches panels (`DesktopSidebarLayout`): toward the right when the new
 * view lies to the left in the switcher (and the reverse), the new block
 * arriving behind it from the other side; slow to start, then fast. The
 * views form one strip (`planSidebarPush`), so a switch made mid-push carries
 * on from where every view is. The arriving view's header is there at once;
 * the one leaving keeps an empty header and takes no input. Views pushed
 * away stay mounted, as they were, until the strip rests. While it arrives,
 * the new block is outlined on all four sides by lines that bleed glass,
 * fading out whole once it rests. Opening and closing do not push.
 */
export function DesktopSuperViewStage({ active }: { active: SuperViewId | 'none' }) {
  const slideRefs = useRef(new Map<SuperViewId, HTMLElement>());
  const placedRef = useRef(new Set<SuperViewId>());
  const outlineRef = useRef<HTMLSpanElement>(null);
  const next = active === 'none' ? null : active;
  const [stage, setStage] = useState<SuperViewStage<SuperViewId>>({ shown: next, behind: [], push: null });
  if (next !== stage.shown) setStage(chooseSuperView(stage, next, ORDER));
  const { shown, behind, push } = stage;

  useLayoutEffect(() => {
    const slides = slideRefs.current;
    if (!push || !shown) {
      for (const slide of slides.values()) for (const part of pushedParts(slide)) cancelPush(part);
      return undefined;
    }
    // Reduced motion: the views pushed away are hidden (super-view-header.css).
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    // Read where every view placed before this switch is right now, running
    // pushes included, then move the strip on from there.
    const target = slides.get(shown);
    const overlay = overlayOf(target);
    const width = overlay?.clientWidth || window.innerWidth;
    const now = [...slides].filter(([view]) => placedRef.current.has(view))
      .map(([view, slide]) => ({ key: view, x: pushedX(slide) }));
    const moves = planSidebarPush(now, shown, width, push.dir);
    for (const slide of slides.values()) for (const part of pushedParts(slide)) cancelPush(part);
    const outline = outlineRef.current;
    let arrival: { frames: Keyframe[]; clock: Animation } | null = null;
    for (const move of moves) {
      const frames = [{ transform: `translateX(${move.from}px)` }, { transform: `translateX(${move.to}px)` }];
      const arriving = move.key === shown;
      for (const part of pushedParts(slides.get(move.key as SuperViewId))) {
        const animation = startPush(part, frames, arriving);
        if (arriving) arrival ??= { frames, clock: animation };
      }
      if (arriving && outline && overlay) {
        const box = overlay.getBoundingClientRect();
        const top = overlay.querySelector(':scope > .super-view-head')?.getBoundingClientRect().bottom ?? box.top;
        Object.assign(outline.style, {
          left: `${box.left}px`, top: `${top}px`, width: `${box.width}px`, height: `${box.bottom - top}px`,
        });
        arrival = { frames, clock: startPush(outline, frames, false) };
      }
    }
    const kept = new Set(moves.map((move) => move.key));
    setStage((current) => ({ ...current, behind: current.behind.filter((view) => kept.has(view)) }));
    if (outline) trackGlassFlow(outline, () => outline.getBoundingClientRect().left);
    if (!target || !arrival) return undefined;
    // A view still loading arrives as its loading shell. When the view itself
    // takes the shell's place mid-push, its block joins the push where the
    // shell had got to instead of landing still.
    const { frames, clock } = arrival;
    const observer = new MutationObserver(() => {
      for (const part of pushedParts(target)) {
        if (!pushes.has(part)) startPush(part, frames, true, clock.currentTime);
      }
    });
    observer.observe(target, { childList: true, subtree: true });
    clock.finished.then(() => observer.disconnect(), () => observer.disconnect());
    return () => observer.disconnect();
  }, [push]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per switch
  // After the push effect: the views this commit placed, for the next switch.
  useLayoutEffect(() => {
    placedRef.current = new Set(slideRefs.current.keys());
  });
  useEffect(() => {
    if (!push) return undefined;
    const timer = window.setTimeout(() => {
      setStage((current) => ({ ...current, behind: [], push: null }));
    }, PUSH_MS + PUSH_OUTLINE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [push]);

  if (!shown) return null;
  // Kept in switcher order so no view's DOM moves; the arriving one stacks
  // on top by class (super-view-header.css).
  const slides = [
    ...behind.map((view) => ({ view, role: 'out' })),
    { view: shown, role: push ? 'in' : 'still' },
  ].sort((a, b) => ORDER.indexOf(a.view) - ORDER.indexOf(b.view));
  return (
    <>
      {slides.map(({ view, role }) => {
        const View = VIEWS[view];
        return (
          <div key={view}
            ref={(element) => {
              if (element) slideRefs.current.set(view, element);
              else slideRefs.current.delete(view);
            }}
            className={`super-view-slide${role === 'still' ? '' : ` super-view-slide--${role}`}`}>
            <SuperViewLeavingContext.Provider value={role === 'out'}>
              <View />
            </SuperViewLeavingContext.Provider>
          </div>
        );
      })}
      {push && (
        <span ref={outlineRef} className="super-view-slide__outline" aria-hidden="true">
          <span className="flow-line flow-line--h super-view-slide__outline-top" />
          <span className="flow-line flow-line--h super-view-slide__outline-bottom" />
          <span className="flow-line flow-line--v super-view-slide__outline-start" />
          <span className="flow-line flow-line--v super-view-slide__outline-end" />
        </span>
      )}
    </>
  );
}
