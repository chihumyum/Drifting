import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import loglevel from 'loglevel';
import {
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useEntityEditor } from '../../hooks/useEntityEditor';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { docToPlainText } from '../../lib/agent/serialize';
import { FieldDiff } from './FieldReview';
import {
  approveDurableAgentReviewsForEntity,
  rejectDurableAgentReviewsForEntity,
} from '../../lib/agent/durable-review-actions';
import {
  acceptDriftingAgentWriteReview,
  rejectDriftingAgentWriteReview,
} from '../../lib/agent/useDriftingAgentRuntime';
import {
  deleteElementPatchWithSync,
  updateElementPatchWithSync,
} from '../../usecase/synced-entity-commands';
import { AnchoredPopover } from '../ui/AnchoredPopover';

const log = loglevel.getLogger('PatchEditorCard');
log.setLevel(loglevel.levels.ERROR);

interface PatchEditorCardProps {
  patch: PatchWithSourceTitle;
  projectId: string;
  onChange?: () => void; // notify parent after a save/delete so it can refresh
  onDelete?: () => void;
}

export function PatchEditorCard({ patch, projectId, onChange, onDelete }: PatchEditorCardProps) {
  const { t } = useTranslation();
  const { navigateToNode } = useProjectNavigation();

  const [titleValue, setTitleValue] = useState(patch.title ?? '');
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the CURRENT draft came from the user typing (vs. a sync from
  // patch.title). handleSaveTitle only persists when this is true — so a blur
  // that the user never typed into can NEVER write null over a stored title (the
  // bug that nulled agent-created titles).
  const titleDirtyRef = useRef(false);
  // Re-sync the draft when the stored title changes underneath us — e.g. the
  // agent created this patch WITH a title, or a sync brought a newer one. Without
  // this, titleValue stays at its mount value and the title never shows. Skip
  // while the user is mid-edit so we don't clobber typing.
  useEffect(() => {
    if (document.activeElement !== titleInputRef.current) {
      setTitleValue(patch.title ?? '');
      titleDirtyRef.current = false; // synced value, not a user edit
    }
  }, [patch.title]);
  // Default expanded so the patch body (the actual content) is the visual
  // anchor. Toggle remains for users who want to collapse long bodies.
  const [collapsed, setCollapsed] = useState(false);
  const mentionRepoRef = useRef(createInlineMentionRepository());

  // Persist patch content on every editor update. Reference projection is
  // handled inside useEntityEditor; we just write the doc back to the row
  // (local sqlite) and enqueue the same payload to the server sync queue.
  const handlePersist = useCallback(
    (editor: Editor) => {
      const contentJson = JSON.stringify(editor.getJSON());
      void updateElementPatchWithSync(projectId, patch.id, { contentJson })
        .then(() => {
          onChange?.();
        })
        .catch((error) => log.error('Failed to save patch content:', error));
    },
    [patch.id, projectId, onChange],
  );

  const { editor } = useEntityEditor({
    sourceKind: 'patch',
    sourceId: patch.id,
    // Patch belongs to this element — exclude its name + aliases from
    // both auto-detect and the @-picker so the patch doesn't self-link
    // back to its owner.
    parentElementId: patch.elementId,
    projectId,
    content: patch.contentJson,
    onPersist: handlePersist,
    editorClass: 'focus:outline-none',
  });

  const handleSaveTitle = useCallback(async () => {
    // Only persist a title the USER actually typed — never a blur over a synced
    // value, which could write null over a stored (e.g. agent-created) title.
    if (!titleDirtyRef.current) return;
    titleDirtyRef.current = false;
    if ((patch.title ?? '') === titleValue) return;
    try {
      const nextTitle = titleValue || null;
      await updateElementPatchWithSync(projectId, patch.id, { title: nextTitle });
      onChange?.();
    } catch (error) {
      log.error('Failed to save patch title:', error);
    }
  }, [patch.id, patch.title, titleValue, projectId, onChange]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteElementPatchWithSync(projectId, patch.id);
      // Also clear any inline mentions emitted from this patch.
      await mentionRepoRef.current.deleteAllForSource('patch', patch.id);
      onDelete?.();
    } catch (error) {
      log.error('Failed to delete patch:', error);
    }
  }, [patch.id, projectId, onDelete]);

  // Agent-created patch awaiting review (keep / discard). The agent's create
  // already landed (write-first inline review); this just surfaces it. Resolves out of the
  // edit store on ✓/✗ (or auto-settle). See agent-edit-review.
  const cardRef = useRef<HTMLDivElement>(null);
  const patchChange = useAgentEditStore((s) => {
    const entry = s.pending[entityKey('element', patch.elementId)];
    return (
      entry?.changes.find((c) => c.field?.kind === 'patch' && c.field.key === patch.id) ?? null
    );
  });
  const reviewBatches = useAgentEditStore((s) => s.reviewBatches);
  const reviewOrder = useAgentEditStore((s) => s.reviewOrder);
  const reviewMode = patchChange ? patchChange.mode ?? 'approve' : null;
  const isDeleting = patchChange?.op === 'deleted';
  const isChanged = patchChange?.op === 'changed';
  // For an UPDATE review, oldText stashes the pre-edit { title, contentJson }; the
  // card diffs that against the current patch (title + body plain text).
  const stash = useMemo((): { title: string | null; contentJson: string } | null => {
    if (!isChanged || !patchChange) return null;
    try {
      return JSON.parse(patchChange.oldText);
    } catch {
      return null;
    }
  }, [isChanged, patchChange]);

  const acceptPatch = useCallback(() => {
    const c = patchChange;
    if (!c) return;
    if (c.reviewId) {
      void approveDurableAgentReviewsForEntity({
        entityType: 'element',
        id: patch.elementId,
        batches: { reviewBatches, reviewOrder },
        matchesBatch: (batch) =>
          batch.changes.some(
            (change) =>
              change.field?.kind === 'patch' &&
              change.field.key === patch.id,
          ),
        acceptReview: acceptDriftingAgentWriteReview,
        onAllAccepted: (reviewIds) => {
          useAgentEditStore.getState().resolveReviews([...reviewIds]);
          onChange?.();
        },
      }).catch((error) => {
        log.error('Failed to accept durable Agent patch review:', error);
      });
      return;
    }
    // Accept = the agent's action stands: a create stays; a (soft) delete is
    // committed for real now.
    useAgentEditStore.getState().resolveBlocks('element', patch.elementId, [c.blockId]);
    if (c.op === 'deleted') void handleDelete();
  }, [
    patchChange,
    patch.elementId,
    patch.id,
    reviewBatches,
    reviewOrder,
    onChange,
    handleDelete,
  ]);

  const rejectPatch = useCallback(() => {
    const c = patchChange;
    if (!c) return;
    if (c.reviewId) {
      void rejectDurableAgentReviewsForEntity({
        entityType: 'element',
        id: patch.elementId,
        batches: { reviewBatches, reviewOrder },
        matchesBatch: (batch) =>
          batch.changes.some(
            (change) =>
              change.field?.kind === 'patch' &&
              change.field.key === patch.id,
          ),
        rejectReview: rejectDriftingAgentWriteReview,
        decisionNote: 'Rejected from the element patch review card',
        onAllReverted: (reviewIds, batches) => {
          const store = useAgentEditStore.getState();
          for (const batch of batches) {
            for (const change of batch.changes) {
              if (
                change.field?.kind === 'patch' &&
                change.field.key === patch.id
              ) {
                store.recordRevert(
                  projectId,
                  'element',
                  patch.elementId,
                  change,
                );
              }
            }
          }
          store.resolveReviews([...reviewIds]);
          onChange?.();
        },
      }).catch((error) => {
        log.error('Failed to reject durable Agent patch review:', error);
      });
      return;
    }
    // Reject = undo the agent's action (and tell it next turn, since it ran
    // bypassPermissions): undo a create by deleting; undo a (soft) delete by
    // keeping the still-present row.
    useAgentEditStore.getState().recordRevert(projectId, 'element', patch.elementId, c);
    useAgentEditStore.getState().resolveBlocks('element', patch.elementId, [c.blockId]);
    if (c.op === 'new') {
      void handleDelete();
    } else if (c.op === 'changed') {
      // Restore the pre-edit title + body stashed in oldText.
      void (async () => {
        try {
          const old = JSON.parse(c.oldText) as { title: string | null; contentJson: string };
          await updateElementPatchWithSync(projectId, patch.id, {
            title: old.title,
            contentJson: old.contentJson,
          });
          onChange?.();
        } catch (error) {
          log.error('Failed to restore patch on reject:', error);
        }
      })();
    }
  }, [
    patchChange,
    projectId,
    patch.elementId,
    patch.id,
    reviewBatches,
    reviewOrder,
    handleDelete,
    onChange,
  ]);

  // Auto mode: once the card is on screen, settle (keep) after a brief beat.
  const acceptRef = useRef(acceptPatch);
  useEffect(() => {
    acceptRef.current = acceptPatch;
  });
  useEffect(() => {
    if (reviewMode !== 'auto') return undefined;
    const el = cardRef.current;
    if (!el) return undefined;
    let hold = 0;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.4 && !hold) {
            io.disconnect();
            hold = window.setTimeout(() => acceptRef.current(), 900);
          }
        }
      },
      { threshold: [0, 0.4, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (hold) window.clearTimeout(hold);
    };
  }, [reviewMode, patch.id]);

  // Source-chapter picker: a floating popover anchored under the head row.
  // Listed in reading order (bookOrder), plus an explicit detach option.
  // Changing the chapter resets sourceBlockId to null — block ids are
  // chapter-scoped, keeping the old id under a new chapter would dangle.
  const [anchorEditing, setAnchorEditing] = useState(false);
  const anchorButtonRef = useRef<HTMLButtonElement | null>(null);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const chapterOptions = useMemo(
    () =>
      bookNodes
        .filter((n) => n.projectId === projectId && n.kind === 'chapter')
        .slice()
        .sort((a, b) => (a.bookOrder ?? 0) - (b.bookOrder ?? 0)),
    [bookNodes, projectId],
  );

  const handleChangeAnchor = useCallback(
    async (nextNodeId: string | null) => {
      setAnchorEditing(false);
      if (nextNodeId === patch.sourceNodeId) return;
      try {
        await updateElementPatchWithSync(projectId, patch.id, {
          sourceNodeId: nextNodeId,
          sourceBlockId: null,
        });
        onChange?.();
      } catch (error) {
        log.error('Failed to change patch anchor:', error);
      }
    },
    [patch.id, patch.sourceNodeId, projectId, onChange],
  );

  // Whether the patch's sourceBlock still exists in the source chapter.
  // null = unknown / not applicable (no sourceBlockId, or check in flight).
  // true / false drive the anchor label + snapshot panel below.
  //
  // We read the chapter's content_json once per (nodeId, blockId) pair and
  // walk it for a node carrying matching attrs.id. BlockId extension
  // serializes the id under `attrs.id` (see block-id.ts). Synchronous walk
  // is fine here — chapter docs are at most a few hundred blocks.
  const [blockExists, setBlockExists] = useState<boolean | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);

  useEffect(() => {
    if (!patch.sourceNodeId || !patch.sourceBlockId) {
      // No source to check against. Render branches below already gate on
      // patch.sourceBlockId so blockExists' stale value is inert here —
      // skip the reset rather than sync-setState in the effect.
      return;
    }
    let cancelled = false;
    const wantedId = patch.sourceBlockId;
    void createBookContentRepository()
      .findByNodeId(patch.sourceNodeId)
      .then((content) => {
        if (cancelled) return;
        if (!content) {
          setBlockExists(false);
          return;
        }
        try {
          const doc = JSON.parse(content.contentJson);
          setBlockExists(docContainsBlockId(doc, wantedId));
        } catch {
          // Malformed JSON — treat as "unknown" so the UI keeps the legacy
          // label and doesn't falsely claim the block is deleted.
          setBlockExists(null);
        }
      })
      .catch(() => {
        if (!cancelled) setBlockExists(null);
      });
    return () => {
      cancelled = true;
    };
  }, [patch.sourceNodeId, patch.sourceBlockId]);

  const hasSnapshot = !!patch.sourceBlockText && patch.sourceBlockText.trim().length > 0;
  const sourceMissing = !!patch.sourceBlockId && blockExists === false;

  // The exact selected text captured (and frozen) when the patch was created,
  // pulled from its text anchor. When the patch is later invalidated (that text
  // was deleted from the chapter), clicking the 失效 badge reveals this snapshot
  // so the user can still see what the patch was anchored to.
  const anchorSnapshotText = useMemo(() => {
    if (!patch.textAnchorJson) return '';
    try {
      const a = JSON.parse(patch.textAnchorJson) as { text?: unknown };
      return typeof a.text === 'string' ? a.text.trim() : '';
    } catch {
      return '';
    }
  }, [patch.textAnchorJson]);

  // The snapshot the expandable panel shows: the deleted anchored selection for
  // an invalidated text-anchored patch, else the legacy block snapshot.
  const invalidSnapshot = !!patch.invalidatedAt && anchorSnapshotText.length > 0;
  const snapshotText = invalidSnapshot
    ? anchorSnapshotText
    : hasSnapshot
      ? (patch.sourceBlockText ?? '')
      : '';

  const anchorLabel = patch.sourceBlockId
    ? sourceMissing
      ? t('patchEditorCard.anchor.sourceDeleted', {
          title: patch.sourceNodeTitle ?? t('patchEditorCard.deletedChapter'),
        })
      : t('patchEditorCard.anchor.sourceBlock', {
          title: patch.sourceNodeTitle ?? t('patchEditorCard.deletedChapter'),
        })
    : (patch.sourceNodeTitle ?? t('patchEditorCard.anchor.noChapter'));

  // Anchor-click behavior forks three ways:
  //   - original block deleted (+ snapshot exists) → toggle the snapshot
  //     panel inline rather than navigating to nothing
  //   - block-level patch with a live sourceBlockId → open the chapter
  //     tab AND scroll to that specific block (editor mounts async, so
  //     scrollToBlockWhenReady waits for the DOM)
  //   - chapter-level patch (no sourceBlockId) → open the chapter tab
  const handleAnchorClick = useCallback(() => {
    if (sourceMissing && hasSnapshot) {
      setSnapshotOpen((v) => !v);
      return;
    }
    if (!patch.sourceNodeId) return;
    navigateToNode(patch.sourceNodeId);
    // Invalidated patches' anchored text was deleted, so the block is stale or
    // gone — scrolling to it would land on the wrong place or nowhere. Just open
    // the chapter editor; the original text lives in the 失效 snapshot instead.
    if (patch.sourceBlockId && !patch.invalidatedAt) {
      scrollToBlockWhenReady(patch.sourceNodeId, patch.sourceBlockId);
    }
  }, [
    sourceMissing,
    hasSnapshot,
    patch.sourceNodeId,
    patch.sourceBlockId,
    patch.invalidatedAt,
    navigateToNode,
  ]);

  const anchorTitle = sourceMissing
    ? hasSnapshot
      ? t('patchEditorCard.anchor.viewSnapshotTitle', { label: anchorLabel })
      : anchorLabel
    : patch.invalidatedAt
      ? t('patchEditorCard.anchor.invalidJumpTitle', { label: anchorLabel })
      : t('patchEditorCard.anchor.jumpTitle', { label: anchorLabel });

  return (
    <div
      ref={cardRef}
      className={`patch-card${sourceMissing ? ' patch-card--source-missing' : ''}${
        patch.invalidatedAt ? ' patch-card--invalidated' : ''
      }${reviewMode ? (isDeleting ? ' patch-card--removing' : ' patch-card--proposed') : ''}`}
    >
      {reviewMode && (
        <div className="patch-card__review">
          <span
            className={`patch-card__review-tag${isDeleting ? ' patch-card__review-tag--del' : ''}`}
          >
            {isDeleting
              ? t('patchEditorCard.review.agentDelete')
              : isChanged
                ? t('patchEditorCard.review.agentChange')
                : t('patchEditorCard.review.agentAdd')}
          </span>
          {reviewMode === 'approve' && (
            <span className="patch-card__review-actions">
              <button
                type="button"
                className="field-review__btn field-review__btn--ok"
                title={
                  isDeleting
                    ? t('patchEditorCard.review.confirmDelete')
                    : isChanged
                      ? t('patchEditorCard.review.acceptChange')
                      : t('patchEditorCard.review.keepPatch')
                }
                onClick={acceptPatch}
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                className="field-review__btn field-review__btn--no"
                title={
                  isDeleting
                    ? t('patchEditorCard.review.restore')
                    : isChanged
                      ? t('patchEditorCard.review.rejectChange')
                      : t('patchEditorCard.review.discardAndDelete')
                }
                onClick={rejectPatch}
              >
                <X size={12} />
              </button>
            </span>
          )}
        </div>
      )}
      <div className="patch-card__head">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="patch-card__toggle"
          aria-label={collapsed ? t('patchEditorCard.actions.expand') : t('patchEditorCard.actions.collapse')}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {/* Title leads the row — it's the patch's primary identifier. */}
        <input
          ref={titleInputRef}
          type="text"
          value={titleValue}
          onChange={(e) => {
            titleDirtyRef.current = true;
            setTitleValue(e.target.value);
          }}
          onBlur={handleSaveTitle}
          placeholder={t('patchEditorCard.titlePlaceholder')}
          className="patch-card__title"
        />
        {/* Invalidated — the anchored source text was deleted from its chapter,
            so this patch is excluded from consistency review until fixed. When a
            text snapshot exists the badge expands it (点击查看原文快照). */}
        {patch.invalidatedAt &&
          (anchorSnapshotText ? (
            <button
              type="button"
              className="patch-card__invalid-badge patch-card__invalid-badge--btn"
              title={t('patchEditorCard.invalid.viewSnapshotTitle')}
              aria-expanded={snapshotOpen}
              onClick={() => {
                setCollapsed(false);
                setSnapshotOpen((v) => !v);
              }}
            >
              {t('patchEditorCard.invalid.label')} {snapshotOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span
              className="patch-card__invalid-badge"
              title={t('patchEditorCard.invalid.title')}
            >
              {t('patchEditorCard.invalid.label')}
            </span>
          ))}
        {/* Source-chapter anchor — SECONDARY, sits after the title. Click
            semantics fork on whether the original block still exists (see
            handleAnchorClick); the ✎ re-anchors. */}
        {patch.sourceNodeId ? (
          <button
            type="button"
            onClick={handleAnchorClick}
            className={
              'patch-card__anchor-link' +
              (sourceMissing ? ' patch-card__anchor-link--missing' : '')
            }
            title={anchorTitle}
            aria-expanded={sourceMissing && hasSnapshot ? snapshotOpen : undefined}
          >
            {sourceMissing && hasSnapshot && (
              <span className="patch-card__anchor-disclosure" aria-hidden>
                {snapshotOpen ? '▾' : '▸'}
              </span>
            )}
            {anchorLabel}
          </button>
        ) : (
          <span className="patch-card__anchor-empty" title={anchorLabel}>
            {anchorLabel}
          </span>
        )}
        <div className="patch-card__anchor-edit-slot">
          <button
            ref={anchorButtonRef}
            type="button"
            onClick={() => setAnchorEditing((v) => !v)}
            className="patch-card__anchor-edit"
            title={t('patchEditorCard.anchor.changeChapter')}
            aria-label={t('patchEditorCard.anchor.editSourceChapter')}
            aria-expanded={anchorEditing}
            aria-haspopup="listbox"
          >
            ✎
          </button>
          <AnchoredPopover
            anchorRef={anchorButtonRef}
            open={anchorEditing}
            onClose={() => setAnchorEditing(false)}
            placement="bottom-end"
            maxHeight={320}
            className="patch-card__anchor-pop"
            role="listbox"
            ariaLabel={t('patchEditorCard.anchor.assignTo')}
          >
              <div className="patch-card__anchor-pop-kicker">{t('patchEditorCard.anchor.assignTo')}</div>
              <div className="patch-card__anchor-pop-list">
                {chapterOptions.length === 0 && (
                  <div className="patch-card__anchor-pop-empty">
                    {t('patchEditorCard.anchor.noChapters')}
                  </div>
                )}
                {chapterOptions.map((n) => {
                  const current = n.id === patch.sourceNodeId;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      role="option"
                      aria-selected={current}
                      className={
                        'patch-card__anchor-pop-item' +
                        (current ? ' patch-card__anchor-pop-item--current' : '')
                      }
                      onClick={() => void handleChangeAnchor(n.id)}
                    >
                      <span className="patch-card__anchor-pop-mark">{current ? '✓' : ''}</span>
                      {/* Title + summary preview so the user can recognize the
                          chapter without leaving to recall its contents. */}
                      <span className="patch-card__anchor-pop-body">
                        <span className="patch-card__anchor-pop-title">
                          {n.title || t('patchEditorCard.untitledChapter')}
                        </span>
                        {n.summary?.trim() && (
                          <span className="patch-card__anchor-pop-summary">{n.summary.trim()}</span>
                        )}
                      </span>
                      {current && patch.sourceBlockId && (
                        <span className="patch-card__anchor-pop-tail">
                          {t('patchEditorCard.anchor.blockLevel')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="patch-card__anchor-pop-sep" />
              <button
                type="button"
                role="option"
                aria-selected={!patch.sourceNodeId}
                className={
                  'patch-card__anchor-pop-item patch-card__anchor-pop-item--detach' +
                  (!patch.sourceNodeId ? ' patch-card__anchor-pop-item--current' : '')
                }
                onClick={() => void handleChangeAnchor(null)}
              >
                <span className="patch-card__anchor-pop-mark">
                  {!patch.sourceNodeId ? '✓' : ''}
                </span>
                <span className="patch-card__anchor-pop-title">
                  {t('patchEditorCard.anchor.noChapter')}
                </span>
              </button>
          </AnchoredPopover>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          className="patch-card__delete"
          aria-label={t('patchEditorCard.actions.deletePatch')}
        >
          ×
        </button>
      </div>
      {!collapsed && snapshotOpen && snapshotText && (
        <div className="patch-card__snapshot">
          {invalidSnapshot && (
            <div className="patch-card__snapshot-kicker">
              {t('patchEditorCard.snapshot.kicker')}
            </div>
          )}
          <pre className="patch-card__snapshot-body">{snapshotText}</pre>
        </div>
      )}
      {!collapsed &&
        (isChanged ? (
          // Show the title/body diff in place of the (otherwise stale) editor
          // while the update is under review; the editor returns on ✓/✗.
          <div className="patch-card__review-diff">
            {(stash?.title ?? '') !== (patch.title ?? '') && (
              <div>
                <span className="patch-card__review-diff-title">
                  {t('patchEditorCard.review.titleField')}
                </span>{' '}
                <FieldDiff oldText={stash?.title ?? ''} newText={patch.title ?? ''} />
              </div>
            )}
            <FieldDiff
              oldText={stash ? docToPlainText(stash.contentJson) : ''}
              newText={docToPlainText(patch.contentJson)}
            />
          </div>
        ) : (
          <div className="patch-card__body">
            <EditorContent editor={editor} />
          </div>
        ))}
    </div>
  );
}

// Walks a TipTap doc JSON tree looking for a block-level node whose
// `attrs.id` matches `blockId`. Returns true on first hit. Cheap iterative
// DFS — chapter docs are bounded by user input size.
function docContainsBlockId(doc: unknown, blockId: string): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== 'object') continue;
    const attrs = node.attrs as Record<string, unknown> | undefined;
    if (attrs && attrs.id === blockId) return true;
    const content = node.content;
    if (Array.isArray(content)) {
      for (const child of content) stack.push(child);
    }
  }
  return false;
}
