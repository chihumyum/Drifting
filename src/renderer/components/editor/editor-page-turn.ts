import { PAGE_BLEND_EASING, PAGE_BLEND_MS } from '../../lib/motion';

/**
 * The paper turning to another page (docs/design-system/motion.md, 翻页).
 * The page replacing the one in front dissolves in over it, in place, over
 * PAGE_BLEND_MS; the page underneath stays whole until it is covered, so the
 * ink on the paper never thins. A turn made while another is still running
 * carries on from where the paper is.
 *
 * Only the turns started here are ever cancelled, never an animation a page
 * runs itself.
 */
const turns = new WeakMap<Element, Animation>();

export interface PageTurnStage<Surface extends { revisionKey: string }> {
  /** The surface in front. */
  committed: Surface | null;
  /** The surface it replaced, whole under it while the page turns. */
  leaving: Surface | null;
}

/**
 * Puts a ready surface in front. Replacing another one turns the page when
 * `turn` (the book is in view and motion is allowed): the surface replaced
 * stays shown, leaving, until the new one covers it.
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

/**
 * Turns the paper from `outgoing` to `incoming`, both already shown, the
 * incoming one above. Returns the incoming page's dissolve; once it finishes
 * the outgoing page is covered and its owner hides it.
 */
export function turnPage(incoming: HTMLElement, outgoing: HTMLElement): Animation {
  // Turned again mid-dissolve: the page still arriving rests whole underneath
  // and the next one starts from the share of the paper it already had, so a
  // turn straight back carries on from where the paper is.
  const from = turns.has(outgoing) ? 1 - Number(getComputedStyle(outgoing).opacity) : 0;
  stopPageTurn(incoming);
  stopPageTurn(outgoing);
  const dissolve = incoming.animate(
    [{ opacity: from }, { opacity: 1 }],
    { duration: PAGE_BLEND_MS, easing: PAGE_BLEND_EASING },
  );
  turns.set(incoming, dissolve);
  dissolve.finished.then(() => {
    if (turns.get(incoming) === dissolve) turns.delete(incoming);
  }, () => undefined);
  return dissolve;
}
