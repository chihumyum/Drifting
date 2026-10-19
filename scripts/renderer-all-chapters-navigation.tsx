import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualChapterRow } from '../src/renderer/components/editor/VirtualChapterRow';
import { EditorOutlineRail } from '../src/renderer/components/editor/EditorOutlineRail';
import { createAllChaptersNavigator } from '../src/renderer/components/editor/all-chapters-navigation';
import { scrollToOutlineAnchor } from '../src/renderer/components/editor/outline-scroll';
import type { OutlineEntry } from '../src/renderer/components/editor/outline-rail-model';
import type { ChapterNode } from '../src/renderer/domain/book-node';
import type { NodeContent } from '../src/renderer/domain/node-content';
import { createMobileAllChaptersLoader } from '../src/renderer/shells/mobile/workspace/mobile-all-chapters';
import '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/comments-review.css';

const noop = () => {};
const noColor = () => null;
const chapters: ChapterNode[] = Array.from({ length: 60 }, (_, index) => ({
  id: `chapter-${index}`, projectId: 'synthetic-book', kind: 'chapter',
  title: `Synthetic chapter ${index}`, summary: 'Synthetic navigation fixture',
  bookOrder: index, narrativeOrder: null, driftGroupId: null, position: { x: 0, y: 0 },
  // Deliberately inaccurate estimates exercise cold vs measured layout.
  wordCount: index % 2 ? 80 : 16000, writingStatus: 'draft', createdAt: '', updatedAt: '',
}));
const content = new Map(chapters.map((chapter, index) => [chapter.id, {
  nodeId: chapter.id, outlineJson: '', plotGridJson: '{}', createdAt: '', updatedAt: '',
  contentJson: JSON.stringify({ type: 'doc', content: [1, 2, 3].flatMap(level => [
    { type: 'heading', attrs: { level, id: `${chapter.id}-h${level}` },
      content: [{ type: 'text', text: `Heading ${index}.${level}` }] },
    ...Array.from({ length: 8 + index % 4 }, (_, paragraph) => ({ type: 'paragraph',
      attrs: { id: `${chapter.id}-p${level}-${paragraph}` },
      content: [{ type: 'text', text: 'Synthetic prose for navigation and painting. '.repeat(5) }] })),
  ]) }),
} satisfies NodeContent]));
const items: OutlineEntry[] = chapters.flatMap((chapter, index) => [
  ...(index % 20 === 0 ? [{ id: `act:act-${index}`, kind: 'act' as const, level: 1,
    text: `Synthetic act ${index / 20 + 1}` }] : []),
  { id: chapter.id, kind: 'chapter' as const, level: 2, text: chapter.title,
    children: [1, 2, 3].map(level => ({ id: `${chapter.id}-h${level}`, level,
      kind: 'heading' as const, text: `Heading ${index}.${level}` })) },
]);
const api = { panes: {} as Record<string, {
  jump: (id: string) => Promise<boolean>; cancel: () => void;
  legacy: (id: string) => void; reads: string[];
}> };
Object.assign(window, { __BOOK_NAV__: api });

function createFixtureReader() {
  const reads: string[] = [];
  const cache = new Map<string, Promise<NodeContent | null>>();
  const loader = createMobileAllChaptersLoader(async (id: string) => {
    reads.push(id);
    await new Promise(resolve => setTimeout(resolve, id === 'chapter-45' ? 700 : 80));
    return content.get(id) ?? null;
  });
  return { reads, fetchContent: (id: string) => {
    if (!cache.has(id)) cache.set(id, loader(id));
    return cache.get(id)!;
  } };
}

export function Pane({ name }: { name: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>('chapter-0');
  const [reader] = useState(createFixtureReader);
  useEffect(() => {
    const navigator = createAllChaptersNavigator({ getRoot: () => root.current,
      prepareChapter: (id) => { setDestination(id); return reader.fetchContent(id); },
    });
    api.panes[name] = {
      jump: (id) => {
        setActive(id);
        const actId = id.startsWith('act:') ? id.slice(4) : undefined;
        const chapterId = actId ? actId.replace('act-', 'chapter-') : id.replace(/-h[123]$/, '');
        return navigator.navigate({ chapterId, actId, blockId: /-h[123]$/.test(id) ? id : undefined });
      },
      cancel: navigator.cancel,
      legacy: (id) => scrollToOutlineAnchor(id, root.current),
      reads: reader.reads,
    };
    return () => { navigator.cancel(); delete api.panes[name]; };
  }, [name, reader]);
  return <div className="editor-shell" data-pane={name} style={{ height: '100vh', width: '50vw' }}>
    <div className="editor-body">
      <EditorOutlineRail title="Synthetic outline" items={items} activeId={active}
        onItemClick={id => void api.panes[name].jump(id)} />
      <div className="editor-scroll" ref={root}>
        {chapters.map((chapter, index) => <section key={chapter.id}>
          {index % 20 === 0 && <div className="act-break" data-act-id={`act-${index}`}>
            <div className="act-break__label">Synthetic act {index / 20 + 1}</div>
          </div>}
          <VirtualChapterRow node={chapter} projectId="synthetic-book" index={index}
            fetchContent={reader.fetchContent} isFocused={false} isNavigationTarget={destination === chapter.id}
            onActivate={noop} onContentUpdate={noop} chapterRoman={String(index + 1)}
            resolveEntityLinkColor={noColor} />
        </section>)}
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex' }}>
  <Pane name="left" /><Pane name="right" />
</div>);
