import { useCallback, useEffect, useRef, useState } from 'react';

// Track which outline anchor is currently "active" as the user scrolls the
// editor body. Active = the last heading whose top has scrolled past a
// threshold below the scroll container's top edge.
//
// Pass the scroll container (.editor-scroll) as state-backed element rather
// than a plain ref so the effect re-runs when the element first attaches.
// Anchors are resolved inside that scroll container by `data-block-id` first
// (headings inside the editor), then by a scoped id lookup (static section
// anchors). This matters when split panes render the same ids.
//
// Returns the active id plus a `pin(id)` callback the view should call when the
// user clicks a TOC row. Pinning holds the highlight on the clicked anchor
// until that anchor scrolls out of the viewport. Without it, clicking a row
// whose section is already fully on-screen wouldn't move the highlight: the
// scroll barely changes, so the threshold rule keeps the *previous* (higher)
// heading active. The pin lets the clicked row win until the reader scrolls
// its section away, at which point the normal scroll-spy resumes.
export function useOutlineScrollspy(
  scrollRoot: HTMLElement | null,
  ids: string[],
  offset = 80,
): { activeId: string | null; pin: (id: string) => void } {
  const idsKey = ids.join('|');
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const pinnedRef = useRef<string | null>(null);

  const pin = useCallback((id: string) => {
    pinnedRef.current = id;
    setActive(id);
  }, []);

  useEffect(() => {
    if (!scrollRoot || ids.length === 0) {
      setActive(ids[0] ?? null);
      return;
    }
    const resolve = (id: string): HTMLElement | null => {
      const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id;
      return (
        scrollRoot.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
        scrollRoot.querySelector<HTMLElement>(`#${escaped}`)
      );
    };
    const recompute = () => {
      // A pinned (just-clicked) anchor wins as long as it is still on-screen.
      // Once it leaves the viewport — or can't be resolved — drop the pin and
      // fall through to the normal threshold scan.
      const pinned = pinnedRef.current;
      if (pinned) {
        const el = resolve(pinned);
        if (el) {
          const rootRect = scrollRoot.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const inView = r.bottom > rootRect.top && r.top < rootRect.bottom;
          if (inView) {
            setActive(pinned);
            return;
          }
        }
        pinnedRef.current = null;
      }
      const rootTop = scrollRoot.getBoundingClientRect().top + offset;
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const id of ids) {
        const el = resolve(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= rootTop + 24) {
          const dist = rootTop - top;
          if (dist < bestDist) {
            bestDist = dist;
            bestId = id;
          }
        }
      }
      setActive(bestId ?? ids[0] ?? null);
    };
    recompute();
    scrollRoot.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      scrollRoot.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
    // ids is intentionally tracked via the joined key — avoids the effect
    // re-attaching every render when the parent rebuilds the items array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRoot, idsKey, offset]);

  return { activeId: active, pin };
}
