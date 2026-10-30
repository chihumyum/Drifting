import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ShareEntity } from '../shared/share-document';

const OPEN_DELAY_MS = 120;

export const ENTITY_FALLBACK_COLOR: Record<ShareEntity['kind'], string> = {
  element: 'hsl(var(--el-person))',
  node: 'hsl(var(--story-2))',
  category: 'hsl(var(--story-3))',
  storyline: 'hsl(var(--story-6))',
};

export interface OpenEntityCard {
  key: string;
  rect: DOMRect;
}

/**
 * Which entity link's card is open. A pointer resting on a link or focus on it
 * opens it; a tap toggles it; scrolling, Escape or leaving the link closes it.
 */
export function useEntityCard(rootRef: RefObject<HTMLElement | null>, scrollerRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState<OpenEntityCard | null>(null);
  const timer = useRef<number>(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const linkOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[data-entity]') : null;
    const show = (link: HTMLElement) => setOpen({ key: link.dataset.entity!, rect: link.getBoundingClientRect() });
    const cancel = () => window.clearTimeout(timer.current);
    const over = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || event.pointerType !== 'mouse') return;
      cancel();
      timer.current = window.setTimeout(() => show(link), OPEN_DELAY_MS);
    };
    const out = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
      cancel();
      if (document.activeElement !== link) setOpen(null);
    };
    const click = (event: MouseEvent) => {
      const link = linkOf(event.target);
      if (!link) return;
      // A tap opens it; a selection being made over the link is left alone.
      if (!window.getSelection()?.isCollapsed) return;
      cancel();
      setOpen(current => (current?.key === link.dataset.entity ? null : { key: link.dataset.entity!, rect: link.getBoundingClientRect() }));
    };
    const focusIn = (event: FocusEvent) => { const link = linkOf(event.target); if (link) show(link); };
    const focusOut = (event: FocusEvent) => { if (linkOf(event.target)) setOpen(null); };
    const close = () => { cancel(); setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const outside = (event: PointerEvent) => { if (!linkOf(event.target)) close(); };
    const scroller = scrollerRef.current;
    root.addEventListener('pointerover', over);
    root.addEventListener('pointerout', out);
    root.addEventListener('click', click);
    root.addEventListener('focusin', focusIn);
    root.addEventListener('focusout', focusOut);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    scroller?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      cancel();
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('click', click);
      root.removeEventListener('focusin', focusIn);
      root.removeEventListener('focusout', focusOut);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      scroller?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [rootRef, scrollerRef]);
  return open;
}
