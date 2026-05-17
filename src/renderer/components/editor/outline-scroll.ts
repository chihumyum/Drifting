// Scroll the document to an outline anchor. The id can refer to either:
//   - a block-id on a heading rendered inside the editor body (set by the
//     BlockId extension as data-block-id="<uuid>"), or
//   - a static section anchor placed by an editor view (e.g. id="sl-overview").
// Both are resolved in one go so views don't have to branch.
export function scrollToOutlineAnchor(id: string): void {
  if (!id) return;
  const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id;
  const target =
    document.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
    document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
