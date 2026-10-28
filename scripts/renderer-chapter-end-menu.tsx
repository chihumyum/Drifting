import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualChapterRow } from '../src/renderer/components/editor/VirtualChapterRow';
import {
  ChapterEndMenu,
  ChapterEndOrnament,
  type ChapterEndReviewState,
} from '../src/renderer/components/editor/ChapterEndOrnament';
import { actForOrder, type BookAct } from '../src/renderer/domain/book-act';
import type { BookNode, ChapterNode } from '../src/renderer/domain/book-node';
import { chapterOrderAfter } from '../src/renderer/domain/chapter-insert';
import type { NodeContent } from '../src/renderer/domain/node-content';
import '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/materials.css';

const noop = () => {};
const noColor = () => null;
const chapter = (id: string, bookOrder: number): ChapterNode => ({
  id, projectId: 'synthetic-book', kind: 'chapter', title: `Synthetic ${id}`, summary: '',
  bookOrder, narrativeOrder: null, driftGroupId: null, position: { x: 0, y: 0 },
  wordCount: 40, writingStatus: 'draft', createdAt: '', updatedAt: '',
});
// Two acts: the boundary at 12 sits between chapter-b (10) and chapter-c (15),
// so inserting after chapter-b must stay in the first act.
const acts: BookAct[] = [null, 12].map((startOrder, index) => ({
  id: `act-${index + 1}`, projectId: 'synthetic-book', name: `Act ${index + 1}`, color: null,
  startOrder, driftNodeId: null, createdAt: '', updatedAt: '',
}));
// Like the view's content cache, repeat reads return the same object; a fresh
// object per read would make each row refetch on every content change.
const contents = new Map<string, NodeContent>();
const fetchContent = async (id: string): Promise<NodeContent> => {
  if (!contents.has(id)) contents.set(id, {
    nodeId: id, outlineJson: '', plotGridJson: '{}', createdAt: '', updatedAt: '',
    contentJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph',
      content: [{ type: 'text', text: `Synthetic prose of ${id}.` }] }] }),
  });
  return contents.get(id)!;
};

const api = {
  inserts: [] as Array<{ after: string; id: string; bookOrder: number; act: string | null }>,
  statuses: [] as Array<{ id: string; status: string }>,
  reviews: [] as string[],
};
Object.assign(window, { __CHAPTER_END__: api });

export function Book() {
  const [chapters, setChapters] = useState(() => [chapter('chapter-a', 5), chapter('chapter-b', 10), chapter('chapter-c', 15)]);
  const [reviews, setReviews] = useState<Record<string, ChapterEndReviewState>>({});
  const chaptersRef = useRef(chapters);
  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);
  const insertAfter = useCallback((afterId: string) => {
    const current = chaptersRef.current;
    const after = current.find((node) => node.id === afterId)!;
    const bookOrder = chapterOrderAfter(current.map((node) => node.bookOrder), acts, after.bookOrder);
    const id = `inserted-${api.inserts.length + 1}`;
    api.inserts.push({ after: afterId, id, bookOrder, act: actForOrder(acts, bookOrder)?.id ?? null });
    setChapters([...current, chapter(id, bookOrder)].sort((a, b) => a.bookOrder - b.bookOrder));
  }, []);
  const toggleFinished = useCallback((id: string) => {
    const writingStatus = chaptersRef.current.find((node) => node.id === id)?.writingStatus === 'finished' ? 'draft' : 'finished';
    api.statuses.push({ id, status: writingStatus });
    setChapters((current) => current.map((node) => (node.id === id ? { ...node, writingStatus } : node)));
  }, []);
  // A synthetic dispatcher: starting for a moment, then running.
  const review = useCallback((id: string) => {
    api.reviews.push(id);
    setReviews((current) => ({ ...current, [id]: 'starting' }));
    setTimeout(() => setReviews((current) => ({ ...current, [id]: 'running' })), 300);
  }, []);
  const renderEnd = useCallback((node: BookNode) => (
    <ChapterEndMenu finished={node.writingStatus === 'finished'}
      onInsert={() => insertAfter(node.id)} onToggleFinished={() => toggleFinished(node.id)}
      reviewState={reviews[node.id] ?? 'idle'} onReview={() => review(node.id)} />
  ), [insertAfter, review, reviews, toggleFinished]);
  return <div className="editor-shell" style={{ height: '100vh' }}>
    <div className="editor-body">
      <div className="editor-scroll" data-testid="book">
        {chapters.map((node, index) => <section key={node.id}>
          <VirtualChapterRow node={node} projectId="synthetic-book" index={index}
            fetchContent={fetchContent} isFocused={false} onActivate={noop} onContentUpdate={noop}
            renderEnd={renderEnd} chapterRoman={String(index + 1)} resolveEntityLinkColor={noColor} />
        </section>)}
        <article className="page" data-testid="decorative"><ChapterEndOrnament /></article>
        <div style={{ height: '70vh' }} />
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Book />);
