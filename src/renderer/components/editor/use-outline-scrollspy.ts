import { useEffect, useState } from 'react';

// Track which outline anchor is currently "active" as the user scrolls the
// editor body. Active = the last heading whose top has scrolled past a
// threshold below the scroll container's top edge.
//
// Pass the scroll container (.editor-scroll) as state-backed element rather
// than a plain ref so the effect re-runs when the element first attaches.
// Anchors are resolved by `data-block-id` first (headings inside the editor)
// then by `getElementById` (static section anchors).
export function useOutlineScrollspy(
  scrollRoot: HTMLElement | null,
  ids: string[],
  offset = 80,
): string | null {
  const idsKey = ids.join('|');
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (!scrollRoot || ids.length === 0) {
      setActive(ids[0] ?? null);
      return;
    }
    const resolve = (id: string): HTMLElement | null => {
      const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id;
      return (
        document.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
        document.getElementById(id)
      );
    };
    const recompute = () => {
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

  return active;
}
