// Wait for a chapter editor to mount the requested BlockId-tagged DOM
// node, then scroll it into view. Used after a tab switch where the
// editor is hydrated asynchronously — a direct querySelector at the
// call site would race against the editor mount and silently miss.
//
// Scoping: if a wrapper with `data-chapter-id` exists (all-chapters /
// split-pane layouts), prefer the block inside that scope. Falls back
// to a document-wide search for the single-chapter view, where the
// chapter editor isn't wrapped.

export interface ScrollToBlockOptions {
  /** How long to wait for the block to appear before giving up. */
  timeoutMs?: number;
}

export function scrollToBlockWhenReady(
  nodeId: string,
  blockId: string,
  opts: ScrollToBlockOptions = {},
): void {
  if (!blockId) return;
  const escapedBlock = cssEscape(blockId);
  const escapedNode = cssEscape(nodeId);
  const scopedSelector = `[data-chapter-id="${escapedNode}"] [data-block-id="${escapedBlock}"]`;
  const unscopedSelector = `[data-block-id="${escapedBlock}"]`;

  const find = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(scopedSelector) ??
    document.querySelector<HTMLElement>(unscopedSelector);

  const hit = (el: HTMLElement) => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const immediate = find();
  if (immediate) {
    hit(immediate);
    return;
  }

  // Editor isn't mounted yet (or this chapter just got swapped in). Watch
  // the DOM until the target block appears, then scroll once and stop.
  let resolved = false;
  const observer = new MutationObserver(() => {
    if (resolved) return;
    const el = find();
    if (!el) return;
    resolved = true;
    observer.disconnect();
    hit(el);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after a bounded window so a missing block doesn't leak the
  // observer. 2s is comfortably past a typical tab switch + editor mount.
  window.setTimeout(() => {
    if (resolved) return;
    resolved = true;
    observer.disconnect();
  }, opts.timeoutMs ?? 2000);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(value) : value;
}
