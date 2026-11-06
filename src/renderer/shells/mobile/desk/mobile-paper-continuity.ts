import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { PAGE_BLEND_MS } from '../../../lib/motion';
import type { MobilePaper } from '../workspace/mobile-workspace-session';

const SCROLLER = '.editor-scroll, .all-chapters-scroll, .dash';
/** How long a reopened paper may take to lay out before its place is given up. */
const RESTORE_WITHIN_MS = 1600;

function scrollerIn(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(SCROLLER) ?? null;
}

/**
 * Each paper is reopened where the author left it: its scroll position is
 * remembered as it scrolls and given back once the reopened page is tall
 * enough to hold it.
 */
export function usePaperScrollMemory(
  pageRef: RefObject<HTMLElement | null>,
  paper: MobilePaper | null,
  remember: (key: string, scrollTop: number) => void,
  active: boolean,
): void {
  const key = paper?.key ?? null;
  const saved = paper?.scrollTop ?? 0;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => {
    const page = pageRef.current;
    if (!active || !key || !page) return undefined;
    let scroller: HTMLElement | null = null;
    let timer = 0;
    let restoring = savedRef.current > 0;
    const started = performance.now();
    const onScroll = () => {
      if (restoring || !scroller) return;
      const top = scroller.scrollTop;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => remember(key, top), 140);
    };
    const tryRestore = () => {
      if (!restoring || !scroller) return;
      const target = savedRef.current;
      if (scroller.scrollHeight - scroller.clientHeight >= target || performance.now() - started > RESTORE_WITHIN_MS) {
        scroller.scrollTop = target;
        restoring = false;
      }
    };
    const attach = () => {
      const next = scrollerIn(page);
      if (next !== scroller) {
        scroller?.removeEventListener('scroll', onScroll);
        scroller = next;
        scroller?.addEventListener('scroll', onScroll, { passive: true });
      }
      tryRestore();
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(page, { childList: true, subtree: true });
    const giveUp = window.setTimeout(() => { tryRestore(); restoring = false; observer.disconnect(); }, RESTORE_WITHIN_MS + 50);
    return () => {
      observer.disconnect();
      window.clearTimeout(giveUp);
      window.clearTimeout(timer);
      scroller?.removeEventListener('scroll', onScroll);
    };
  }, [active, key, pageRef, remember]);
}

/** Reading down this far puts the paper's toolbar away; scrolling back this far brings it. */
const READ_AWAY_PX = 24;
const READ_BACK_PX = 36;

/**
 * While the author reads on down the page, the paper's toolbar steps aside so
 * the words have the whole width; scrolling back up a little, or reaching
 * either end of the page, brings it back. The dock stays: it is how the
 * author leaves the page.
 */
export function useReadingAway(pageRef: RefObject<HTMLElement | null>, pageKey: string): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;
    setAway(false);
    let scroller: HTMLElement | null = null;
    let anchor = 0;
    let state = false;
    const onScroll = () => {
      if (!scroller) return;
      const top = scroller.scrollTop;
      const atEnd = top <= 4 || top + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atEnd) {
        anchor = top;
        if (state) { state = false; setAway(false); }
        return;
      }
      if (!state && top - anchor > READ_AWAY_PX) { state = true; setAway(true); anchor = top; return; }
      if (state && anchor - top > READ_BACK_PX) { state = false; setAway(false); anchor = top; return; }
      if (state ? top > anchor : top < anchor) anchor = top;
    };
    const attach = () => {
      const next = scrollerIn(page);
      if (next === scroller) return;
      scroller?.removeEventListener('scroll', onScroll);
      scroller = next;
      anchor = scroller?.scrollTop ?? 0;
      scroller?.addEventListener('scroll', onScroll, { passive: true });
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(page, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
    };
  }, [pageKey, pageRef]);
  return away;
}

/**
 * A page turn (docs/design-system/motion.md, 翻页): when the paper in front
 * changes, the page that was there stays, whole, under the new one while the
 * new one dissolves in over it; then it is taken away. The page left behind is
 * a still copy of what was on screen, so nothing under it can be pressed.
 */
export function usePageTurn(pageRef: RefObject<HTMLElement | null>, pageKey: string): void {
  const previousKey = useRef(pageKey);
  const lastFrame = useRef<HTMLElement | null>(null);

  // Before React swaps the page, keep a still copy of what is on screen.
  const page = pageRef.current;
  if (page && previousKey.current !== pageKey && !lastFrame.current) {
    const copy = page.cloneNode(true) as HTMLElement;
    const live = scrollerIn(page);
    const scrolled = live?.scrollTop ?? 0;
    copy.classList.add('m-paper__page--leaving');
    copy.removeAttribute('data-debug-id');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    copy.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'));
    copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    copy.dataset.scrolled = String(scrolled);
    lastFrame.current = copy;
  }

  useLayoutEffect(() => {
    if (previousKey.current === pageKey) return undefined;
    previousKey.current = pageKey;
    const copy = lastFrame.current;
    lastFrame.current = null;
    const live = pageRef.current;
    if (!copy || !live?.parentElement) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    live.parentElement.insertBefore(copy, live);
    const scroller = scrollerIn(copy);
    if (scroller) scroller.scrollTop = Number(copy.dataset.scrolled) || 0;
    live.classList.add('m-paper__page--arriving');
    const done = window.setTimeout(() => {
      copy.remove();
      live.classList.remove('m-paper__page--arriving');
    }, PAGE_BLEND_MS + 40);
    return () => {
      window.clearTimeout(done);
      copy.remove();
      live.classList.remove('m-paper__page--arriving');
    };
  }, [pageKey, pageRef]);
}
