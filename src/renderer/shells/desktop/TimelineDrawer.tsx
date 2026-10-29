import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { trackGlassFlow } from '../../lib/glass-flow';
import { STRUCTURAL_MS } from '../../lib/motion';

/**
 * The Bottom Timeline slides up from under the paper and back down, like the
 * sidebars (a structural movement: STRUCTURAL_MS, the same as the
 * `.desktop-workspace-dock` height transition): its top edge and lane dividers bleed glass while it moves
 * (lib/glass-flow.ts). It stays mounted through the outgoing slide.
 */
export function TimelineDrawer({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const opened = useRef(open);

  // Reopening mid-slide cancels the pending unmount.
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || opened.current === open) return;
    opened.current = open;
    const from = open ? 0 : el.getBoundingClientRect().height;
    const to = open ? el.scrollHeight : 0;
    el.classList.add('is-sliding');
    el.style.height = `${from}px`;
    void el.offsetHeight;
    el.style.height = `${to}px`;
    trackGlassFlow(el, () => el.getBoundingClientRect().height);
  }, [open, mounted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const timer = window.setTimeout(() => {
      el.classList.remove('is-sliding');
      if (open) el.style.height = '';
      else setMounted(false);
    }, STRUCTURAL_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div ref={ref} className="workspace-dock desktop-workspace-dock">
      <span className="flow-line flow-line--h desktop-workspace-dock__flow" aria-hidden="true" />
      {children}
    </div>
  );
}
