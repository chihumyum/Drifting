import { useCallback, useEffect, useRef, useState } from 'react';
import type { BookNode } from '../../domain/book-node';
import type { NodeContent } from '../../domain/node-content';
import { ChapterEditor } from '../editor/ChapterEditor';
import { useBookNode } from '../../usecase/useBookNode';
import { useBookContent } from '../../usecase/useBookContent';
import { useDataStore } from '../../store/data-store';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import loglevel from 'loglevel';

const log = loglevel.getLogger('NodeCardPopover');
log.setLevel(loglevel.levels.WARN);

const POPOVER_WIDTH = 360;
const POPOVER_GAP = 10;
const UPGRADE_WIDTH = 640;
const UPGRADE_HEIGHT_MAX = 720;

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NodeCardPopoverProps {
  node: BookNode;
  projectId: string;
  userId: string;
  anchorRect: AnchorRect;
  onClose: () => void;
  onOpenInEditor: (nodeId: string) => void;
}

export function NodeCardPopover({
  node,
  projectId,
  userId,
  anchorRect,
  onClose,
  onOpenInEditor,
}: NodeCardPopoverProps) {
  const [mode, setMode] = useState<'default' | 'upgrade'>('default');
  const [summaryDraft, setSummaryDraft] = useState(node.summary ?? '');
  const summaryRef = useAutosizeTextArea(summaryDraft);
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  // Which nodeId the bookContent above corresponds to. Until this matches
  // node.id, the upgrade-state UI shows a loading placeholder. Tracking it
  // this way (vs a separate `contentLoaded` boolean) avoids a setState-in-
  // effect at the top of the load effect.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeNodeIdRef = useRef(node.id);

  const { updateNodeSummary, renameNode, updateNode } = useBookNode({ projectId, userId });
  const { getContentByNodeId, updateContentByNodeId, createContent } = useBookContent({
    projectId,
    userId,
  });

  // Reset local draft when the popover switches to a new node (e.g. user
  // clicked another tile without first closing) or the node's summary was
  // changed elsewhere.
  const [syncKey, setSyncKey] = useState({ id: node.id, summary: node.summary });
  if (syncKey.id !== node.id || syncKey.summary !== node.summary) {
    setSyncKey({ id: node.id, summary: node.summary });
    setSummaryDraft(node.summary ?? '');
  }

  useEffect(() => {
    activeNodeIdRef.current = node.id;
  }, [node.id]);

  // Lazy content load — only when the user upgrades.
  useEffect(() => {
    if (mode !== 'upgrade') return;
    let cancelled = false;
    const target = node.id;
    (async () => {
      try {
        const cont = await getContentByNodeId(target);
        if (cancelled || activeNodeIdRef.current !== target) return;
        setBookContent(cont);
        setLoadedFor(target);
      } catch (err) {
        log.error('Failed to load content for popover editor', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, node.id, getContentByNodeId]);

  const contentLoaded = loadedFor === node.id;

  // Esc closes the popover in both modes. The explicit "折叠" button still
  // lets users move from the compact editor back to the summary card.
  // We use the capture phase so we run before StoryGraphView's own Esc-closes-the-
  // super-view handler, and call stopPropagation to suppress that.
  // If a form field or the tiptap editor inside the popover has focus, we
  // let that element's own Esc handler (revert/blur) run instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement as HTMLElement | null;
      const inField =
        !!active &&
        (active.tagName === 'TEXTAREA' ||
          active.tagName === 'INPUT' ||
          active.isContentEditable);
      if (inField && containerRef.current?.contains(active)) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Outside click closes (both modes: in upgrade mode, the modal is the
  // container, so clicking outside the modal box closes).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      onClose();
    };
    // Defer one tick so the very click that opened us doesn't immediately
    // close it.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // --- Save handlers ---
  const handleSummaryBlur = useCallback(async () => {
    const next = summaryDraft.trim();
    if (next === (node.summary ?? '').trim()) return;
    try {
      await updateNodeSummary(node.id, next);
    } catch (err) {
      log.error('Failed to update summary', err);
    }
  }, [summaryDraft, node.id, node.summary, updateNodeSummary]);

  const handleTitleUpdate = useCallback(
    async (id: string, title: string) => {
      try {
        await renameNode(id, title);
      } catch (err) {
        log.error('Failed to rename node', err);
      }
    },
    [renameNode],
  );

  const handleSummaryUpdate = useCallback(
    async (id: string, summary: string) => {
      try {
        await updateNodeSummary(id, summary);
      } catch (err) {
        log.error('Failed to update summary', err);
      }
    },
    [updateNodeSummary],
  );

  const persistWordCountIfChanged = useCallback(
    (id: string, nextWordCount: number) => {
      const current = useDataStore.getState().bookNodes.find((n) => n.id === id);
      if (!current || current.wordCount === nextWordCount) return;
      void updateNode(id, { wordCount: nextWordCount }).catch((err) => {
        log.error('Failed to persist wordCount', err);
      });
    },
    [updateNode],
  );

  const handleContentUpdate = useCallback(
    async (targetNodeId: string, pmJson: string, outlineJson: string, nextWordCount: number) => {
      try {
        const existing = await getContentByNodeId(targetNodeId);
        if (existing) {
          const updated = await updateContentByNodeId(targetNodeId, {
            contentJson: pmJson,
            outlineJson,
          });
          if (updated && activeNodeIdRef.current === targetNodeId) {
            setBookContent(updated);
          }
        } else {
          const created = await createContent(targetNodeId, { contentJson: pmJson, outlineJson });
          if (activeNodeIdRef.current === targetNodeId) {
            setBookContent(created);
          }
        }
        persistWordCountIfChanged(targetNodeId, nextWordCount);
      } catch (err) {
        log.error('Failed to update content', err);
      }
    },
    [getContentByNodeId, updateContentByNodeId, createContent, persistWordCountIfChanged],
  );

  // --- Positioning ---
  const popoverStyle: React.CSSProperties = (() => {
    if (mode === 'upgrade') {
      const h = Math.min(UPGRADE_HEIGHT_MAX, window.innerHeight - 64);
      return {
        position: 'fixed',
        width: UPGRADE_WIDTH,
        height: h,
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchorCenterX = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenterX - POPOVER_WIDTH / 2;
    left = Math.max(8, Math.min(left, vw - POPOVER_WIDTH - 8));
    // Prefer above the tile; if not enough room, place below.
    const estimatedHeight = 220;
    const spaceAbove = anchorRect.top;
    const spaceBelow = vh - (anchorRect.top + anchorRect.height);
    let top: number;
    if (spaceAbove >= estimatedHeight + POPOVER_GAP || spaceAbove >= spaceBelow) {
      top = anchorRect.top - estimatedHeight - POPOVER_GAP;
      top = Math.max(8, top);
    } else {
      top = anchorRect.top + anchorRect.height + POPOVER_GAP;
    }
    return {
      position: 'fixed',
      width: POPOVER_WIDTH,
      left,
      top,
    };
  })();

  const labelNum =
    node.bookOrder != null ? `§ ${String(node.bookOrder).padStart(2, '0')}` : '§ —';

  return (
    <>
      {mode === 'upgrade' && <div className="node-card-backdrop" />}
      <div
        ref={containerRef}
        className={`node-card${mode === 'upgrade' ? ' is-upgrade' : ''}`}
        style={popoverStyle}
        role="dialog"
        aria-label="章节卡片"
      >
        {mode === 'default' ? (
          <>
            <div className="node-card__head">
              <span className="node-card__num">{labelNum}</span>
              <span className="node-card__title" title={node.title || '未命名'}>
                {node.title || '未命名'}
              </span>
              <button
                type="button"
                className="node-card__close"
                onClick={onClose}
                title="关闭"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <textarea
              ref={summaryRef}
              className="node-card__summary"
              value={summaryDraft}
              placeholder="写一段摘要…"
              onChange={(e) => setSummaryDraft(e.target.value)}
              onBlur={handleSummaryBlur}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSummaryDraft(node.summary ?? '');
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
              }}
              rows={1}
            />
            <div className="node-card__foot">
              <button
                type="button"
                className="node-card__btn"
                onClick={() => setMode('upgrade')}
                title="展开为简化编辑器"
              >
                展开编辑 ↗
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title="跳转到完整编辑器"
              >
                在编辑器中打开 →
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="node-card__head">
              <span className="node-card__num">{labelNum}</span>
              <span className="node-card__title">简化编辑</span>
              <button
                type="button"
                className="node-card__btn is-ghost"
                onClick={() => setMode('default')}
                title="折叠回卡片"
              >
                ↙ 折叠
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title="跳转到完整编辑器"
              >
                完整编辑器 →
              </button>
              <button
                type="button"
                className="node-card__close"
                onClick={onClose}
                title="关闭"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="node-card__editor">
              {contentLoaded ? (
                <ChapterEditor
                  key={node.id}
                  nodeId={node.id}
                  projectId={projectId}
                  content={bookContent?.contentJson ?? null}
                  title={node.title}
                  summary={node.summary}
                  onContentUpdate={handleContentUpdate}
                  onTitleUpdate={handleTitleUpdate}
                  onSummaryUpdate={handleSummaryUpdate}
                  showTitle
                  showSummary
                  editableTitle
                  editableSummary
                  compact
                  minHeight="320px"
                />
              ) : (
                <div className="node-card__loading">载入中…</div>
              )}
            </div>
            <div className="node-card__editor-foot">
              <span className="node-card__meta">
                {node.wordCount ?? 0} 字 · 改动会同步到完整编辑器
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
