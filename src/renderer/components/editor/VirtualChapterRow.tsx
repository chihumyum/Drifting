import { useEffect, useRef, useState, useCallback, memo } from 'react';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import type { NodeContent } from '../../domain/node-content';
import type { EntityLinkRef } from '../../lib/extensions/entity-link';
import type { OutlineItem } from '../../lib/outline';
import { ChapterEditor } from './ChapterEditor';

const log = loglevel.getLogger('VirtualChapterRow');
log.setLevel(loglevel.levels.WARN);

// Roughly characters → estimated rendered height. The page body wraps at
// ~22 chars/line (Chinese mixed prose) and lines are ~32px tall. Conservative
// estimate so placeholders are slightly taller than reality, avoiding upward
// jumps when an editor mounts.
function estimateChapterHeight(wordCount: number): number {
  const lines = Math.max(6, Math.ceil(wordCount / 22));
  const body = lines * 32;
  const chrome = 220; // title + summary + folio + ornament padding
  return body + chrome;
}

interface VirtualChapterRowProps {
  node: BookNode;
  projectId: string;
  index: number;

  // Returns persisted content for this chapter, or null if none yet. The row
  // fetches on demand the first time it becomes "near" the viewport.
  fetchContent: (nodeId: string) => Promise<NodeContent | null>;

  onContentUpdate: (nodeId: string, pmJson: string, outlineJson: string, wordCount: number) => void;
  onTitleUpdate?: (nodeId: string, title: string) => void;
  onSummaryUpdate?: (nodeId: string, summary: string) => void;
  onEntityClick?: (ref: EntityLinkRef) => void;
  onHeightMeasured?: (nodeId: string, height: number) => void;
  // Published whenever the mounted ChapterEditor's heading outline changes,
  // so the all-chapters view can show the focused chapter's TOC in the
  // outline panel. Unmounted (placeholder) rows don't emit anything.
  onOutlineChange?: (nodeId: string, outline: OutlineItem[]) => void;

  // Whether the row should be considered "current" (e.g. via scrollspy or
  // explicit selection). Draws a left rail similar to NodeEditorView's
  // active indicator.
  isActive?: boolean;

  // Last-known measured height to use as the placeholder height when not
  // mounted. Falls back to a wordCount-derived estimate when unset.
  cachedHeight?: number;

  // Color of the chapter's main storyline (for the page chapter mark).
  storylineColor?: string;
  storylineName?: string;
  chapterRoman: string;
}

// One chapter slot in the all-chapters editor. Mounts/unmounts the heavy
// TipTap editor based on viewport proximity via IntersectionObserver, with
// the goal of keeping a 200-chapter book responsive.
//
// Lifecycle:
//   • Placeholder mode (default): renders a fixed-height div with a chapter
//     header preview. The height is the last measured value if we've ever
//     mounted before, otherwise a wordCount-based estimate.
//   • Mounted mode (when `isNear`): fetches content lazily on first entry,
//     then renders <ChapterEditor> inside the same .page article layout the
//     single-chapter view uses. While mounted, we record the actual rendered
//     height so a later unmount preserves layout.
//
// We do NOT keep the editor mounted forever — that would balloon memory on
// large books. We accept losing per-chapter undo history when scrolling far,
// since edits are auto-persisted on every keystroke through onContentUpdate.
function VirtualChapterRowImpl({
  node,
  projectId,
  index,
  fetchContent,
  onContentUpdate,
  onTitleUpdate,
  onSummaryUpdate,
  onEntityClick,
  onHeightMeasured,
  onOutlineChange,
  isActive,
  cachedHeight,
  storylineColor,
  storylineName,
  chapterRoman,
}: VirtualChapterRowProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isNear, setIsNear] = useState(false);
  const [content, setContent] = useState<NodeContent | null | undefined>(undefined);
  const fetchingRef = useRef(false);

  const placeholderHeight = cachedHeight ?? estimateChapterHeight(node.wordCount || 0);

  // Mount-when-near observer.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === el) {
            setIsNear(entry.isIntersecting);
          }
        }
      },
      // 150% margin: mount editors roughly 1.5 viewports above and below the
      // visible region so quick scrolls don't reveal placeholders.
      { rootMargin: '150% 0px 150% 0px', threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Lazy content fetch on first "near" entry.
  useEffect(() => {
    if (!isNear) return;
    if (content !== undefined) return;
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    let cancelled = false;
    void fetchContent(node.id)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
      })
      .catch((error) => {
        log.error(`[VirtualChapterRow] Failed to fetch content for ${node.id}`, error);
        if (cancelled) return;
        setContent(null);
      })
      .finally(() => {
        fetchingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [isNear, content, fetchContent, node.id]);

  // Measure rendered height while mounted so the cached value stays current.
  useEffect(() => {
    if (!isNear) return;
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) onHeightMeasured?.(node.id, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isNear, node.id, onHeightMeasured]);

  const handleContentUpdate = useCallback(
    (nodeId: string, pmJson: string, outlineJson: string, wordCount: number) => {
      onContentUpdate(nodeId, pmJson, outlineJson, wordCount);
    },
    [onContentUpdate],
  );

  const handleOutlineChange = useCallback(
    (outline: OutlineItem[]) => {
      onOutlineChange?.(node.id, outline);
    },
    [onOutlineChange, node.id],
  );

  return (
    <div
      ref={wrapperRef}
      data-chapter-id={node.id}
      data-chapter-index={index}
      style={{
        position: 'relative',
        minHeight: isNear ? undefined : placeholderHeight,
      }}
    >
      {isActive && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 8,
            bottom: 8,
            width: 3,
            background: 'hsl(var(--accent))',
            borderRadius: 2,
            zIndex: 5,
          }}
        />
      )}

      {isNear ? (
        <div ref={innerRef} className="editor__spread">
          <article className="page">
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Chapter</span>
              <span className="page__folio-line page__folio-line--accent">{chapterRoman}</span>
              {storylineName && (
                <span
                  className="page__folio-line"
                  style={{ color: storylineColor, fontWeight: 600 }}
                >
                  {storylineName}
                </span>
              )}
              <span className="page__folio-line">
                {(node.wordCount || 0).toLocaleString()} 字
              </span>
            </div>

            {storylineName && (
              <div className="page__chapter-mark">— {storylineName} —</div>
            )}

            {content === undefined ? (
              <div
                style={{
                  minHeight: 200,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'hsl(var(--ink-4))',
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            ) : (
              <ChapterEditor
                nodeId={node.id}
                projectId={projectId}
                content={content?.contentJson ?? null}
                title={node.title}
                summary={node.summary || ''}
                onContentUpdate={handleContentUpdate}
                onTitleUpdate={onTitleUpdate}
                onSummaryUpdate={onSummaryUpdate}
                onEntityClick={onEntityClick}
                onOutlineChange={handleOutlineChange}
                showTitle={true}
                showSummary={true}
                editableTitle={true}
                editableSummary={true}
                autoFocus={false}
                minHeight="240px"
              />
            )}

            <div className="page__ornament" aria-hidden="true">⁂</div>
          </article>
        </div>
      ) : (
        <PlaceholderRow
          node={node}
          chapterRoman={chapterRoman}
          storylineColor={storylineColor}
          storylineName={storylineName}
          height={placeholderHeight}
        />
      )}
    </div>
  );
}

function PlaceholderRow({
  node,
  chapterRoman,
  storylineColor,
  storylineName,
  height,
}: {
  node: BookNode;
  chapterRoman: string;
  storylineColor?: string;
  storylineName?: string;
  height: number;
}) {
  return (
    <div
      style={{
        height,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        alignItems: 'center',
        gap: 12,
        padding: '64px 24px',
        color: 'hsl(var(--ink-4))',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'hsl(var(--ink-5))',
        }}
      >
        Chapter {chapterRoman}
        {storylineName && (
          <>
            <span style={{ margin: '0 6px' }}>·</span>
            <span style={{ color: storylineColor || 'hsl(var(--ink-5))' }}>{storylineName}</span>
          </>
        )}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 20,
          color: 'hsl(var(--ink-2))',
          fontWeight: 600,
          textAlign: 'center',
          maxWidth: 600,
        }}
      >
        {node.title || 'Untitled'}
      </div>
      {node.summary && (
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 13,
            fontStyle: 'italic',
            color: 'hsl(var(--ink-4))',
            textAlign: 'center',
            maxWidth: 540,
            lineHeight: 1.6,
          }}
        >
          {node.summary}
        </div>
      )}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-5))',
          letterSpacing: '0.1em',
        }}
      >
        {(node.wordCount || 0).toLocaleString()} 字
      </div>
    </div>
  );
}

export const VirtualChapterRow = memo(VirtualChapterRowImpl);
