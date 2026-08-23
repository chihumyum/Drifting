import type { NodeContent } from '../../../domain/node-content';
import {
  applyBookFindHighlights,
  clearBookFindHighlights,
  collectBookMatches,
  containerForMatch,
  type BookMatch,
  type ChapterDoc,
} from '../../../lib/all-chapters-find';
import type { FindChapter } from '../../../components/search/AllChaptersFindPanel';
import type {
  MobilePaperSearchOwner,
  MobilePaperSearchSnapshot,
} from './mobile-paper-search';

export function createMobileAllChaptersSearchOwner({
  chapters,
  fetchContent,
  getScrollRoot,
}: {
  chapters: readonly FindChapter[];
  fetchContent: (nodeId: string) => Promise<NodeContent | null>;
  getScrollRoot: () => HTMLElement | null;
}): MobilePaperSearchOwner {
  let snapshot: MobilePaperSearchSnapshot = {
    status: 'idle',
    query: '',
    currentIndex: 0,
    total: 0,
  };
  let docsPromise: Promise<ChapterDoc[]> | null = null;
  let matches: BookMatch[] = [];
  let request = 0;
  const listeners = new Set<() => void>();
  const publish = (next: MobilePaperSearchSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const loadDocs = () => {
    if (!docsPromise) {
      docsPromise = Promise.all(
        chapters.map(async (chapter) => {
          try {
            const content = await fetchContent(chapter.nodeId);
            return { ...chapter, contentJson: content?.contentJson ?? null };
          } catch {
            return { ...chapter, contentJson: null };
          }
        }),
      );
    }
    return docsPromise;
  };
  const paint = () => {
    const root = getScrollRoot();
    if (!root) return;
    applyBookFindHighlights(root, snapshot.query, matches, snapshot.currentIndex);
  };
  const jump = (nextIndex: number) => {
    if (matches.length === 0) return;
    const currentIndex = ((nextIndex % matches.length) + matches.length) % matches.length;
    const match = matches[currentIndex];
    publish({ ...snapshot, currentIndex });
    const root = getScrollRoot();
    if (!root) return;
    const destination =
      containerForMatch(root, match) ??
      root.querySelector<HTMLElement>(
        `[data-chapter-id="${CSS.escape(match.nodeId)}"]`,
      );
    destination?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    paint();
    requestAnimationFrame(paint);
  };

  return {
    id: 'all-chapters',
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setQuery(query) {
      const currentRequest = ++request;
      if (!query) {
        matches = [];
        clearBookFindHighlights();
        publish({ status: 'idle', query: '', currentIndex: 0, total: 0 });
        return;
      }
      publish({ status: 'searching', query, currentIndex: 0, total: 0 });
      void loadDocs().then((docs) => {
        if (currentRequest !== request) return;
        matches = collectBookMatches(query, docs);
        publish({ status: 'ready', query, currentIndex: 0, total: matches.length });
        if (matches.length > 0) jump(0);
        else paint();
      });
    },
    previous() {
      jump(snapshot.currentIndex - 1);
    },
    next() {
      jump(snapshot.currentIndex + 1);
    },
    clear() {
      request += 1;
      matches = [];
      clearBookFindHighlights();
      publish({ status: 'idle', query: '', currentIndex: 0, total: 0 });
    },
    destroy() {
      request += 1;
      clearBookFindHighlights();
      listeners.clear();
    },
  };
}
