// Scroll the document to an outline anchor. The id can refer to either:
//   - a block-id on a heading rendered inside the editor body (set by the
//     BlockId extension as data-block-id="<uuid>"), or
//   - a static section anchor placed by an editor view (e.g. id="sl-overview").
// Both are resolved in one go so views don't have to branch.
//
// In split-pane mode the same outline ids can exist in BOTH panes (each
// renders its own view instance). A plain document-wide querySelector always
// hits the DOM-earlier (left) match, so clicking the right pane's outline
// would scroll the left pane. Pass a `scope` element (the pane's scroll
// container) to constrain the search to one pane.
export function scrollToOutlineAnchor(id: string, scope?: HTMLElement | null): void {
  if (!id) return;
  const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id;
  const root: ParentNode = scope ?? document;
  const target =
    root.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
    (scope ? scope.querySelector<HTMLElement>(`#${escaped}`) : document.getElementById(id));
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
