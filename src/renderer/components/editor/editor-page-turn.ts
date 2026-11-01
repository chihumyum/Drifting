import {
  PAGE_LEAVE_MS,
  PAGE_RISE_DELAY_MS,
  PAGE_RISE_EASING,
  PAGE_RISE_MS,
  PAGE_RISE_PX,
} from '../../lib/motion';

/**
 * The paper turning to another page (docs/design-system/motion.md, 翻页).
 * The surface in front fades out over PAGE_LEAVE_MS; a moment later the one
 * replacing it floats up PAGE_RISE_PX into place as it fades in. A turn made
 * while another is still running carries on from where both pages are.
 *
 * Only the turns started here are ever cancelled, never an animation a page
 * runs itself.
 */
const turns = new WeakMap<Element, Animation>();

export interface PageTurnStage<Surface extends { revisionKey: string }> {
  /** The surface in front. */
  committed: Surface | null;
  /** The surface it replaced, fading out under it while the page turns. */
  leaving: Surface | null;
}

/**
 * Puts a ready surface in front. Replacing another one turns the page when
 * `turn` (the book is in view and motion is allowed): the surface replaced
 * stays shown, leaving, until its fade ends.
 */
export function commitSurface<Surface extends { revisionKey: string }>(
  stage: PageTurnStage<Surface>,
  surface: Surface,
  turn: boolean,
): PageTurnStage<Surface> {
  if (stage.committed?.revisionKey === surface.revisionKey) return { ...stage, committed: surface };
  return { committed: surface, leaving: turn ? stage.committed : null };
}

/** Cancels the turn running on `surface`, if any, and lets it rest as styled. */
export function stopPageTurn(surface: Element | null | undefined): void {
  if (!surface) return;
  turns.get(surface)?.cancel();
  turns.delete(surface);
}

function track(surface: Element, animation: Animation): Animation {
  turns.set(surface, animation);
  return animation;
}

/**
 * Turns the paper from `outgoing` to `incoming`, both already shown. Returns
 * the outgoing page's fade, which holds it transparent once it finishes until
 * its owner hides it and calls `stopPageTurn`.
 */
export function turnPage(incoming: HTMLElement, outgoing: HTMLElement): Animation {
  // A page still leaving comes back from where its fade has got to, without
  // floating up again; a page still arriving leaves from where it is.
  const returning = turns.has(incoming);
  const returningFrom = returning ? Number(getComputedStyle(incoming).opacity) : 0;
  const leavingStyle = turns.has(outgoing) ? getComputedStyle(outgoing) : null;
  const leavingFrom: Keyframe = {
    opacity: leavingStyle ? Number(leavingStyle.opacity) : 1,
    transform: leavingStyle?.transform ?? 'none',
  };
  stopPageTurn(incoming);
  stopPageTurn(outgoing);

  const rise = returning
    ? incoming.animate(
      [{ opacity: returningFrom }, { opacity: 1 }],
      { duration: PAGE_RISE_MS, easing: PAGE_RISE_EASING },
    )
    : incoming.animate(
      [
        { opacity: 0, transform: `translateY(${PAGE_RISE_PX}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: PAGE_RISE_MS, delay: PAGE_RISE_DELAY_MS, easing: PAGE_RISE_EASING, fill: 'backwards' },
    );
  track(incoming, rise);
  rise.finished.then(() => {
    if (turns.get(incoming) === rise) turns.delete(incoming);
  }, () => undefined);

  return track(outgoing, outgoing.animate(
    [leavingFrom, { ...leavingFrom, opacity: 0 }],
    { duration: PAGE_LEAVE_MS, easing: 'linear', fill: 'forwards' },
  ));
}
