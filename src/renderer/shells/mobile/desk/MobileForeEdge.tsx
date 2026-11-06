import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { canonicalWordCount, isChapter } from '../../../domain/book-node';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { KindMark } from '../../../components/ui/KindMark';

interface ForeEdgeChapter {
  id: string;
  title: string;
  words: number;
  color?: string;
  /** Where the chapter starts and ends on the edge, 0–1. */
  from: number;
  to: number;
}

/** A chapter never shrinks to less than this share of the edge, so each stays reachable. */
const MIN_SHARE = 0.012;

export function foreEdgeChapters(
  chapters: readonly { id: string; title: string; words: number; color?: string }[],
): ForeEdgeChapter[] {
  const total = chapters.reduce((sum, chapter) => sum + Math.max(1, chapter.words), 0) || 1;
  const shares = chapters.map((chapter) => Math.max(MIN_SHARE, Math.max(1, chapter.words) / total));
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return chapters.map((chapter, index) => {
    const from = at;
    at += shares[index] / sum;
    return { ...chapter, from, to: index === chapters.length - 1 ? 1 : at };
  });
}

/** The chapter under `fraction` (0–1) of the edge, and how far into it. */
export function foreEdgeAt(chapters: readonly ForeEdgeChapter[], fraction: number): { chapter: ForeEdgeChapter; within: number } | null {
  if (chapters.length === 0) return null;
  const f = Math.min(1, Math.max(0, fraction));
  const chapter = chapters.find((candidate) => f < candidate.to) ?? chapters[chapters.length - 1];
  const span = chapter.to - chapter.from || 1;
  return { chapter, within: Math.min(1, Math.max(0, (f - chapter.from) / span)) };
}

function scrollerOf(paper: HTMLElement | null): HTMLElement | null {
  return paper?.querySelector<HTMLElement>('.editor-scroll, .all-chapters-scroll, .dash') ?? null;
}

/**
 * The book's fore-edge along the paper's right side (docs/mobile-ui-foundation.md).
 * Every chapter is a stretch of the edge as long as its share of the book's
 * words, in reading order; the chapter in front is inked darker and a grain of
 * sand marks where the page is. Running the thumb down the edge is leafing
 * through the book: the chapter under the thumb comes up beside it, and lifting
 * the thumb turns to it, or, inside the chapter in front, scrolls to that place.
 */
export function MobileForeEdge({ target, paperRef, onOpenChapter }: {
  target: WorkspaceTarget | null;
  paperRef: RefObject<HTMLElement | null>;
  onOpenChapter: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { bookNodes, storylines, primaryStorylineByNode } = useDataStoreFields('bookNodes', 'storylines', 'primaryStorylineByNode');
  const chapters = useMemo(() => {
    const colors = new Map(storylines.map((line) => [line.id, line.color]));
    return foreEdgeChapters(
      bookNodes
        .filter(isChapter)
        .slice()
        .sort((a, b) => a.bookOrder - b.bookOrder)
        .map((node) => {
          const primary = primaryStorylineByNode[node.id];
          return {
            id: node.id,
            title: node.title || t('topTimeline.untitled.chapter'),
            words: canonicalWordCount(node) ?? node.wordCount ?? 0,
            color: primary ? colors.get(primary) : undefined,
          };
        }),
    );
  }, [bookNodes, primaryStorylineByNode, storylines, t]);
  const currentId = target?.entityType === 'node' ? target.id : null;
  const wholeBook = target?.entityType === 'all-chapters';
  const current = chapters.find((chapter) => chapter.id === currentId) ?? null;
  const [reading, setReading] = useState(0);
  const [scrub, setScrub] = useState<{ fraction: number; y: number } | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);

  // Where the page is: the scroll position of the paper in front.
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return undefined;
    let scroller: HTMLElement | null = null;
    let frame = 0;
    const read = () => {
      frame = 0;
      if (!scroller) return;
      const room = scroller.scrollHeight - scroller.clientHeight;
      setReading(room > 0 ? scroller.scrollTop / room : 0);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    const attach = () => {
      const next = scrollerOf(paper);
      if (next === scroller) return;
      scroller?.removeEventListener('scroll', onScroll);
      scroller = next;
      scroller?.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(paper, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [paperRef, target?.entityType, target?.id]);

  if (chapters.length === 0) return null;

  const fractionAt = (clientY: number) => {
    const rect = edgeRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return 0;
    return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setScrub({ fraction: fractionAt(event.clientY), y: event.clientY });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrub) return;
    setScrub({ fraction: fractionAt(event.clientY), y: event.clientY });
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const done = scrub;
    setScrub(null);
    if (!done) return;
    const hit = foreEdgeAt(chapters, fractionAt(event.clientY));
    if (!hit) return;
    const scroller = scrollerOf(paperRef.current);
    if (wholeBook && scroller) {
      scroller.scrollTo({ top: done.fraction * (scroller.scrollHeight - scroller.clientHeight) });
      return;
    }
    if (hit.chapter.id === currentId && scroller) {
      scroller.scrollTo({ top: hit.within * (scroller.scrollHeight - scroller.clientHeight) });
      return;
    }
    onOpenChapter(hit.chapter.id);
  };

  const hit = scrub ? foreEdgeAt(chapters, scrub.fraction) : null;
  const sandAt = wholeBook ? reading : current ? current.from + reading * (current.to - current.from) : null;
  return (
    <div
      ref={edgeRef}
      className="m-fore-edge"
      data-debug-id="mobile-fore-edge"
      data-scrubbing={scrub ? 'true' : undefined}
      role="slider"
      aria-label={t('mobileDesk.foreEdge.label')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((sandAt ?? 0) * 100)}
      aria-valuetext={hit?.chapter.title ?? current?.title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => setScrub(null)}
    >
      {chapters.map((chapter) => (
        <span
          key={chapter.id}
          className="m-fore-edge__leaf"
          data-current={chapter.id === currentId || wholeBook ? 'true' : undefined}
          data-hit={hit?.chapter.id === chapter.id ? 'true' : undefined}
          style={{ top: `${chapter.from * 100}%`, height: `${(chapter.to - chapter.from) * 100}%`, '--leaf-c': chapter.color } as CSSProperties}
        />
      ))}
      {sandAt !== null && !scrub && (
        <span className="m-fore-edge__sand sand sand--blob-2" style={{ top: `${sandAt * 100}%` }} aria-hidden="true" />
      )}
      {scrub && hit && (
        <div className="m-fore-edge__card hover-card-surface" style={{ top: `${scrub.fraction * 100}%` }} aria-hidden="true">
          <KindMark kind="chapter" seed={hit.chapter.id} color={hit.chapter.color} />
          <span className="m-fore-edge__title">{hit.chapter.title}</span>
          <span className="m-fore-edge__words">{hit.chapter.words.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
