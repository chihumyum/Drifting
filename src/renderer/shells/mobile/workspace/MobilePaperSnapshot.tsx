import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NodeContent } from '../../../domain/node-content';
import { chapterJsonToHtml } from '../../../components/editor/chapter-static-html';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import { useBookContent } from '../../../usecase/useBookContent';
import type { MobilePaper } from './mobile-workspace-session';
import { mobilePaperSnapshotIsLoading } from './mobile-paper-snapshot';
import { useMobilePaperPresentation } from './MobilePaperContent';

/**
 * A frozen, read-only paper used beside the one live editor. Chapter prose is
 * rendered with the same serializer and typography as the editor, but without
 * mounting another ProseMirror/Yjs session. Activating the paper replaces this
 * snapshot with the live editor again.
 */
export function MobilePaperSnapshot({
  projectId,
  paper,
  frozenContentJson,
}: {
  projectId: string;
  paper: MobilePaper;
  frozenContentJson?: string;
}) {
  const presentation = useMobilePaperPresentation(paper.target);
  const userId = useAuthStore((state) => state.user?.id);
  const { getContentByNodeId } = useBookContent({ userId: userId ?? '', projectId });
  const projectedContentJson = useDataStore((state) => {
    switch (paper.target.entityType) {
      case 'element':
        return state.bookElements.find((item) => item.id === paper.target.id)?.contentJson ?? '';
      case 'storyline':
        return state.storylines.find((item) => item.id === paper.target.id)?.contentJson ?? '';
      case 'category':
        return (
          state.bookElementCategories.find((item) => item.id === paper.target.id)?.contentJson ?? ''
        );
      default:
        return '';
    }
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<NodeContent | null | undefined>(undefined);

  useEffect(() => {
    if (frozenContentJson !== undefined || paper.target.entityType !== 'node') return;
    let cancelled = false;
    void getContentByNodeId(paper.target.id)
      .then((next) => {
        if (!cancelled) setContent(next);
      })
      .catch(() => {
        if (!cancelled) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [frozenContentJson, getContentByNodeId, paper.target.entityType, paper.target.id]);

  const isProsePaper =
    paper.target.entityType === 'node' ||
    paper.target.entityType === 'element' ||
    paper.target.entityType === 'storyline' ||
    paper.target.entityType === 'category';
  const contentJson =
    frozenContentJson ??
    (paper.target.entityType === 'node' ? content?.contentJson : projectedContentJson);
  const html = useMemo(() => chapterJsonToHtml(contentJson), [contentJson]);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = paper.scrollTop;
  }, [html, paper.scrollTop]);

  if (!isProsePaper) {
    return (
      <div className="m-paper-preview m-paper-preview--static" aria-hidden="true">
        <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
        <small>{presentation.kicker}</small>
        <strong>{presentation.title}</strong>
        <p>{presentation.preview}</p>
      </div>
    );
  }

  return (
    <div className="m-paper-snapshot" aria-hidden="true">
      <div className="editor-shell">
        <div className="editor-body">
          <div ref={scrollRef} className="editor-scroll">
            <div className="editor__spread">
              <article className="page page--entity">
                <div className="page__folio">
                  <span className="page__folio-line">{presentation.kicker}</span>
                </div>
                <h1 className="page__title">{presentation.title}</h1>
                {presentation.preview ? <p className="page__sub">{presentation.preview}</p> : null}
                <hr className="page__rule" />
                <div className="page__body">
                  {mobilePaperSnapshotIsLoading(paper, frozenContentJson, content !== undefined) ? (
                    <div className="m-paper-snapshot__loading" />
                  ) : (
                    <div
                      className="tiptap ProseMirror prose max-w-none m-paper-snapshot__prose"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  )}
                </div>
                <div className="page__ornament" aria-hidden="true">
                  ⁂
                </div>
              </article>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
