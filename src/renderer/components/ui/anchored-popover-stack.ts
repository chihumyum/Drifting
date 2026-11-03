// The anchored popovers open now, in the order they opened. A popover opened
// from inside another (a select's list in a menu) is portalled to body like
// every other, so it is not inside its opener's element: without this, a press
// on the list reads as a press outside the menu, which closes the menu and its
// list before the click lands.

const open: Element[] = [];

/** A popover opened; the returned function takes it off again. */
export function openAnchoredPopover(popover: Element): () => void {
  open.push(popover);
  return () => {
    const at = open.indexOf(popover);
    if (at >= 0) open.splice(at, 1);
  };
}

/** Whether `target` lies in a popover opened after `popover` (one stacked over it). */
export function inPopoverAbove(popover: Element, target: Node): boolean {
  const at = open.indexOf(popover);
  return at >= 0 && open.slice(at + 1).some((above) => above.contains(target));
}

/** Whether `popover` is the last one opened, the one Escape belongs to. */
export function isTopAnchoredPopover(popover: Element): boolean {
  return open[open.length - 1] === popover;
}
