import { useEffect, useMemo, useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import type { NodeContent } from '../../domain/node-content';
import { entityLinkConfig } from '../../lib/extensions/entity-link';
import type { EntityKind, EntityLinkRef } from '../../lib/extensions/entity-link';
import type { OutlineItem } from '../../lib/outline';
import { ChapterEditor } from './ChapterEditor';
import { chapterJsonToHtml } from './chapter-static-html';

const log = loglevel.getLogger('VirtualChapterRow');
log.setLevel(loglevel.levels.WARN);

// Chrome (folio + chapter-mark + title + summary + rule + ornament) around the
// prose body — used to size the body spacer shown before content has loaded.
const CHROME_HEIGHT = 220;

// Rough characters → estimated body height, used ONLY as the
// `contain-intrinsic-size` seed (so content-visibility has a sane offscreen
// guess) and the pre-load body spacer. Once a row's real prose renders, the
// browser remembers its true height and the estimate stops mattering.
function estimateChapterHeight(wordCount: number): number {
  const lines = Math.max(6, Math.ceil(wordCount / 22));
  const body = lines * 32;
  return body + CHROME_HEIGHT;
}

interface VirtualChapterRowProps {
  node: BookNode;
  projectId: string;
  index: number;

  // Returns persisted content for this chapter, or null if none yet. Every row
  // loads its content up front (not gated on proximity) so the read-through
  // always shows real prose at its real height — that's what keeps fast scrolls
  // from jumping.
  fetchContent: (nodeId: string) => Promise<NodeContent | null>;

  // True for the one chapter the user is actively editing. Only that row mounts
  // the heavy ChapterEditor (TipTap + per-chapter Yjs sync + Copilot); everyone
  // else renders cheap static prose.
  isFocused: boolean;
  // Click on a static row → ask the parent to make this the focused editor,
  // carrying the click coords so the caret can land where the user clicked.
  onActivate: (nodeId: string, coords: { clientX: number; clientY: number }) => void;
  // Click coords for caret placement, set by the parent for the focused row.
  activateCaret?: { clientX: number; clientY: number } | null;

  onContentUpdate: (nodeId: string, pmJson: string, outlineJson: string, wordCount: number) => void;
  onTitleUpdate?: (nodeId: string, title: string) => void;
  onSummaryUpdate?: (nodeId: string, summary: string) => void;
  onEntityClick?: (ref: EntityLinkRef) => void;
  // Published whenever the focused chapter's heading outline changes, so the
  // all-chapters view can show its TOC. Static rows publish nothing — their TOC
  // comes from the parent's prefetched outlines.
  onOutlineChange?: (nodeId: string, outline: OutlineItem[]) => void;

  // Color / name of the chapter's main storyline (for the page chapter mark).
  storylineColor?: string;
  storylineName?: string;
  chapterRoman: string;
}

// One chapter slot in the all-chapters editor. Renders the chapter's real prose
// statically by default and only upgrades to a live ChapterEditor when focused.
//
// Why not virtualize with estimated placeholders: a wordCount-based height
// estimate never matches the real rendered height, so fast-scrolling onto a
// not-yet-measured row snapped the viewport (the old "jump to the bottom"). By
// always rendering the real prose — the same HTML the editor produces, in the
// same `.page__body .ProseMirror` container, so heights are identical — there's
// no estimate to be wrong about. `content-visibility:auto` keeps the offscreen
// rows cheap to paint, so even a 100+ chapter book stays responsive, and only
// the focused chapter pays for a full editor instance.
function VirtualChapterRowImpl({
  node,
  projectId,
  index,
  fetchContent,
  isFocused,
  onActivate,
  activateCaret,
  onContentUpdate,
  onTitleUpdate,
  onSummaryUpdate,
  onEntityClick,
  onOutlineChange,
  storylineColor,
  storylineName,
  chapterRoman,
}: VirtualChapterRowProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState<NodeContent | null | undefined>(undefined);

  const intrinsicHeight = estimateChapterHeight(node.wordCount || 0);

  // Load (and, on un-focus, refresh) this row's content. While focused the live
  // editor owns the document, so we don't touch it; when focus leaves we re-read
  // the cache so the static prose reflects edits made while it was the editor.
  useEffect(() => {
    if (isFocused) return;
    let cancelled = false;
    void fetchContent(node.id)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((error) => {
        log.error(`[VirtualChapterRow] fetch content failed for ${node.id}`, error);
        if (!cancelled) setContent((prev) => (prev === undefined ? null : prev));
      });
    return () => {
      cancelled = true;
    };
  }, [isFocused, fetchContent, node.id]);

  const staticHtml = useMemo(
    () => (content == null ? '' : chapterJsonToHtml(content.contentJson)),
    [content],
  );

  const handleContentUpdate = useCallback(
    (nodeId: string, pmJson: string, outlineJson: string, wordCount: number) => {
      // Keep our static-prose source in step with the live editor. The editor
      // flushes this synchronously on blur, so by the time the row reverts to
      // static (on un-focus) the prose already reflects the latest edits —
      // without waiting on the async persist + cache round-trip.
      setContent((prev) => (prev ? { ...prev, contentJson: pmJson, outlineJson } : prev));
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
      data-chapter-id={node.id}
      data-chapter-index={index}
      className="all-chap-row"
      style={{ '--all-chap-row-h': `${Math.round(intrinsicHeight)}px` } as React.CSSProperties}
    >
      <div className="editor__spread">
        <article className="page">
          <div className="page__folio" aria-hidden="true">
            <span className="page__folio-line">{t('virtualChapterRow.chapter')}</span>
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
              {t('common.wordsCount', { count: (node.wordCount || 0).toLocaleString() })}
            </span>
          </div>

          {storylineName && <div className="page__chapter-mark">— {storylineName} —</div>}

          {isFocused ? (
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
              activateCaret={activateCaret ?? null}
              minHeight="240px"
            />
          ) : (
            <StaticChapterBody
              title={node.title}
              summary={node.summary || ''}
              html={staticHtml}
              ready={content !== undefined}
              bodyEstimate={Math.max(240, intrinsicHeight - CHROME_HEIGHT)}
              onActivate={(coords) => onActivate(node.id, coords)}
              onEntityClick={onEntityClick}
            />
          )}

          <div className="page__ornament" aria-hidden="true">⁂</div>
        </article>
      </div>
    </div>
  );
}

// Read-only mirror of ChapterEditor's literary layout. Title/summary come from
// the node (available without a content fetch), so they render immediately; the
// prose body is the serialized contentJson, dropped into the SAME
// `.page__body .ProseMirror` container the editor uses so its height matches the
// live editor exactly. Mousedown anywhere promotes the row to the live editor,
// carrying the click point so the caret lands where the user pressed.
function StaticChapterBody({
  title,
  summary,
  html,
  ready,
  bodyEstimate,
  onActivate,
  onEntityClick,
}: {
  title: string;
  summary: string;
  html: string;
  ready: boolean;
  bodyEstimate: number;
  onActivate: (coords: { clientX: number; clientY: number }) => void;
  onEntityClick?: (ref: EntityLinkRef) => void;
}) {
  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return; // primary click only

      // A click on an entity-link navigates to its target, mirroring the live
      // editor's entity-link handleClick. We act on mousedown (not click)
      // because promoting the row to a live editor swaps the static span out
      // before a `click` could ever land on it. Falls through to normal row
      // activation when interaction is off, the target isn't a link, or it
      // carries no id.
      if (entityLinkConfig.interactionEnabled) {
        const linkEl = (event.target as HTMLElement | null)?.closest(
          '.entity-link',
        ) as HTMLElement | null;
        const targetId = linkEl?.getAttribute('data-target-id');
        if (linkEl && targetId) {
          event.preventDefault();
          const targetKind =
            (linkEl.getAttribute('data-target-kind') as EntityKind) ?? 'element';
          // Non-alive target (trashed/gone): swallow — don't navigate to a
          // phantom, don't place a caret mid-word. Matches the plugin's guard.
          if (entityLinkConfig.resolveTargetState(targetKind, targetId) === 'alive') {
            onEntityClick?.({
              targetKind,
              targetId,
              targetBlockId: linkEl.getAttribute('data-target-block-id'),
            });
          }
          return;
        }
      }

      onActivate({ clientX: event.clientX, clientY: event.clientY });
    },
    [onActivate, onEntityClick],
  );

  return (
    <div onMouseDown={handleMouseDown} style={{ cursor: 'text' }}>
      <h1 className="page__title" style={{ margin: '0 0 10px' }}>
        {title || 'Untitled Chapter'}
      </h1>
      {summary ? (
        <p className="page__sub" style={{ marginBottom: 28 }}>
          {summary}
        </p>
      ) : null}
      <hr className="page__rule" />
      <div className="page__body">
        {ready ? (
          <div
            className="tiptap ProseMirror prose max-w-none all-chap-static"
            style={{ minHeight: 240 }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          // Content not loaded yet — reserve a body-sized spacer so the row
          // doesn't pop when prose arrives.
          <div style={{ minHeight: bodyEstimate }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export const VirtualChapterRow = memo(VirtualChapterRowImpl);
