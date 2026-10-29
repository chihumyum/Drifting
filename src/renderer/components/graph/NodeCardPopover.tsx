import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalWordCount, isDrift, type BookNode } from '../../domain/book-node';
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
import loglevel from 'loglevel';
import { BrushIcon } from '../ui/BrushIcon';
import { Button } from '../ui/Button';
import { KindMark } from '../ui/KindMark';
import { getPlatformRuntime } from '../../platform/runtime';

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
  /** The chapter's storyline colour for its seal (desktop). */
  markColor?: string;
}

export function NodeCardPopover({
  node,
  projectId,
  userId,
  anchorRect,
  onClose,
  onOpenInEditor,
  markColor,
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

  const summaryField = (
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
  );
  const closeButton = (
    <GhostIconButton
      className="node-card__close"
      onClick={onClose}
      title={t('commentRail.actions.close')}
      aria-label={t('commentRail.actions.close')}
      size="sm"
      icon={<BrushIcon name="close" size={14} />}
    />
  );
  const editor = contentLoaded ? (
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
  );
  const wordSync =
    canonicalWordCount(node) == null
      ? t('common.counting')
      : t('nodeCardPopover.wordSync', { count: canonicalWordCount(node) });

  // Desktop: a floating layer (the menu shell) with no rules: the chapter's
  // own seal before its title, the summary in the multi-line field's slip,
  // 展开编辑 as a text button and 在编辑器中打开 the only primary button.
  // Expanded, the text is a sheet of page colour inside the shell. The
  // paused mobile shell keeps the bordered card below.
  if (!getPlatformRuntime().isMobileShell) {
    const mark = isDrift(node)
      ? <KindMark kind="drift" color="hsl(var(--accent))" />
      : <KindMark kind="chapter" seed={node.id} color={markColor} />;
    return (
      <EntityCardPopoverShell
        mode={mode}
        anchorRect={anchorRect}
        popoverWidth={360}
        estimatedHeight={220}
        onClose={onClose}
        ariaLabel={t('nodeCardPopover.aria.card')}
        className="node-card entity-card"
      >
        <div className="entity-card__head">
          {mark}
          <span className="entity-card__num">{labelNum}</span>
          <span className="entity-card__title" title={node.title || t('common.untitled')}>
            {node.title || t('common.untitled')}
          </span>
          {mode === 'upgrade' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('default')}
              title={t('nodeCardPopover.collapseTitle')}
            >
              <BrushIcon name="arrow-in" size={11} /> {t('nodeCardPopover.collapse')}
            </Button>
          )}
          {closeButton}
        </div>
        {mode === 'default' ? (
          <label className="entity-card__slip ui-field ui-field--area glass glass--rest glass--field">
            {summaryField}
          </label>
        ) : (
          <div className="entity-card__page">{editor}</div>
        )}
        <div className="entity-card__foot">
          {mode === 'default' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('upgrade')}
              title={t('nodeCardPopover.expandTitle')}
            >
              <BrushIcon name="arrow-out" size={11} /> {t('nodeCardPopover.expand')}
            </Button>
          ) : (
            <span className="entity-card__meta">{wordSync}</span>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => onOpenInEditor(node.id)}
            title={t('nodeCardPopover.openFullTitle')}
          >
            {mode === 'default' ? t('nodeCardPopover.openInEditor') : t('nodeCardPopover.fullEditor')}
            <BrushIcon name="arrow-forward" size={11} />
          </Button>
        </div>
      </EntityCardPopoverShell>
    );
  }

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
              {closeButton}
            </div>
            {summaryField}
            <div className="node-card__foot">
              <button
                type="button"
                className="node-card__btn"
                onClick={() => setMode('upgrade')}
                title={t('nodeCardPopover.expandTitle')}
              >
                {t('nodeCardPopover.expand')} <BrushIcon name="arrow-out" size={10} inline />
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title={t('nodeCardPopover.openFullTitle')}
              >
                {t('nodeCardPopover.openInEditor')} <BrushIcon name="arrow-forward" size={10} inline />
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
                <BrushIcon name="arrow-in" size={10} inline /> {t('nodeCardPopover.collapse')}
              </button>
              <button
                type="button"
                className="node-card__btn is-primary"
                onClick={() => onOpenInEditor(node.id)}
                title={t('nodeCardPopover.openFullTitle')}
              >
                {t('nodeCardPopover.fullEditor')} <BrushIcon name="arrow-forward" size={10} inline />
              </button>
              {closeButton}
            </div>
            <div className="node-card__editor">
              {editor}
            </div>
            <div className="node-card__editor-foot">
              <span className="node-card__meta">
                {wordSync}
              </span>
            </div>
          </>
        )}
    </EntityCardPopoverShell>
  );
}
