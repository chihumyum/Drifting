import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalWordCount, type BookNode } from '../../domain/book-node';
import type { NodeContent } from '../../domain/node-content';
import { ChapterEditor } from '../editor/ChapterEditor';
import { useBookNode } from '../../usecase/useBookNode';
import { useBookContent } from '../../usecase/useBookContent';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import {
  EntityCardPopoverShell,
  type EntityCardAnchorRect,
} from '../ui/EntityCardPopoverShell';
import { GhostIconButton } from '../ui/GhostIconButton';
import { X } from 'lucide-react';
import loglevel from 'loglevel';

const log = loglevel.getLogger('NodeCardPopover');
log.setLevel(loglevel.levels.WARN);

export type AnchorRect = EntityCardAnchorRect;

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
  const { t } = useTranslation();
  const [mode, setMode] = useState<'default' | 'upgrade'>('default');
  const [summaryDraft, setSummaryDraft] = useState(node.summary ?? '');
  const summaryRef = useAutosizeTextArea(summaryDraft);
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  // Which nodeId the bookContent above corresponds to. Until this matches
  // node.id, the upgrade-state UI shows a loading placeholder. Tracking it
  // this way (vs a separate `contentLoaded` boolean) avoids a setState-in-
  // effect at the top of the load effect.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const activeNodeIdRef = useRef(node.id);

  const { updateNodeSummary, renameNode } = useBookNode({ projectId, userId });
  const { getContentByNodeId } = useBookContent({
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

  const handleContentUpdate = useCallback(
    async (targetNodeId: string, _pmJson: string, _outlineJson: string, _nextWordCount: number) => {
      try {
        const persisted = await getContentByNodeId(targetNodeId);
        if (persisted && activeNodeIdRef.current === targetNodeId) {
          setBookContent(persisted);
        }
      } catch (err) {
        log.error('Failed to reload materialized content', err);
      }
    },
    [getContentByNodeId],
  );

  const labelNum =
    node.bookOrder != null ? `§ ${String(node.bookOrder).padStart(2, '0')}` : '§ —';

  return (
    <EntityCardPopoverShell
        mode={mode}
        anchorRect={anchorRect}
        popoverWidth={360}
        estimatedHeight={220}
        onClose={onClose}
        ariaLabel={t('nodeCardPopover.aria.card')}
        className="node-card"
      >
        {mode === 'default' ? (
          <>
            <div className="node-card__head">
              <span className="node-card__num">{labelNum}</span>
              <span className="node-card__title" title={node.title || t('common.untitled')}>
                {node.title || t('common.untitled')}
              </span>
              <GhostIconButton
                className="node-card__close"
                onClick={onClose}
                title={t('commentRail.actions.close')}
                aria-label={t('commentRail.actions.close')}
                size="sm"
                icon={<X size={14} aria-hidden="true" />}
              />
            </div>
            <textarea
              ref={summaryRef}
              className="node-card__summary"
              value={summaryDraft}
              placeholder={t('nodeCardPopover.summaryPlaceholder')}
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
                title={t('nodeCardPopover.expandTitle')}
              >
                {t('nodeCardPopover.expand')} ↗
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title={t('nodeCardPopover.openFullTitle')}
              >
                {t('nodeCardPopover.openInEditor')} →
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="node-card__head">
              <span className="node-card__num">{labelNum}</span>
              <span className="node-card__title">{t('nodeCardPopover.compactEdit')}</span>
              <button
                type="button"
                className="node-card__btn is-ghost"
                onClick={() => setMode('default')}
                title={t('nodeCardPopover.collapseTitle')}
              >
                ↙ {t('nodeCardPopover.collapse')}
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title={t('nodeCardPopover.openFullTitle')}
              >
                {t('nodeCardPopover.fullEditor')} →
              </button>
              <GhostIconButton
                className="node-card__close"
                onClick={onClose}
                title={t('commentRail.actions.close')}
                aria-label={t('commentRail.actions.close')}
                size="sm"
                icon={<X size={14} aria-hidden="true" />}
              />
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
                <div className="node-card__loading">{t('nodeCardPopover.loading')}</div>
              )}
            </div>
            <div className="node-card__editor-foot">
              <span className="node-card__meta">
                {canonicalWordCount(node) == null
                  ? t('common.counting')
                  : t('nodeCardPopover.wordSync', { count: canonicalWordCount(node) })}
              </span>
            </div>
          </>
        )}
    </EntityCardPopoverShell>
  );
}
