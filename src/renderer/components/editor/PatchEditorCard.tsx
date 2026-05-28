import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import {
  createElementPatchRepository,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useEntityEditor } from '../../hooks/useEntityEditor';
import { useDataStore } from '../../store/data-store';
import {
  syncElementPatchDelete,
  syncElementPatchUpdate,
} from '../../usecase/sync-helpers';

const log = loglevel.getLogger('PatchEditorCard');
log.setLevel(loglevel.levels.ERROR);

interface PatchEditorCardProps {
  patch: PatchWithSourceTitle;
  projectId: string;
  onChange?: () => void; // notify parent after a save/delete so it can refresh
  onDelete?: () => void;
}

export function PatchEditorCard({ patch, projectId, onChange, onDelete }: PatchEditorCardProps) {
  const { navigateToNode } = useProjectNavigation();

  const [titleValue, setTitleValue] = useState(patch.title ?? '');
  // Default expanded so the patch body (the actual content) is the visual
  // anchor. Toggle remains for users who want to collapse long bodies.
  const [collapsed, setCollapsed] = useState(false);
  const patchRepoRef = useRef(createElementPatchRepository());
  const mentionRepoRef = useRef(createInlineMentionRepository());

  // Persist patch content on every editor update. Reference projection is
  // handled inside useEntityEditor; we just write the doc back to the row
  // (local sqlite) and enqueue the same payload to the server sync queue.
  const handlePersist = useCallback(
    (editor: Editor) => {
      const contentJson = JSON.stringify(editor.getJSON());
      void patchRepoRef.current
        .update(patch.id, { contentJson })
        .then(() => {
          syncElementPatchUpdate(patch.id, projectId, { contentJson });
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
    if ((patch.title ?? '') === titleValue) return;
    try {
      const nextTitle = titleValue || null;
      await patchRepoRef.current.update(patch.id, { title: nextTitle });
      syncElementPatchUpdate(patch.id, projectId, { title: nextTitle });
      onChange?.();
    } catch (error) {
      log.error('Failed to save patch title:', error);
    }
  }, [patch.id, patch.title, titleValue, projectId, onChange]);

  const handleDelete = useCallback(async () => {
    try {
      await patchRepoRef.current.delete(patch.id);
      syncElementPatchDelete(patch.id, projectId);
      // Also clear any inline mentions emitted from this patch.
      await mentionRepoRef.current.deleteAllForSource('patch', patch.id);
      onDelete?.();
    } catch (error) {
      log.error('Failed to delete patch:', error);
    }
  }, [patch.id, projectId, onDelete]);

  // Source-chapter picker: a floating popover anchored under the head row.
  // Listed in reading order (bookOrder), plus an explicit detach option.
  // Changing the chapter resets sourceBlockId to null — block ids are
  // chapter-scoped, keeping the old id under a new chapter would dangle.
  const [anchorEditing, setAnchorEditing] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const chapterOptions = useMemo(
    () =>
      bookNodes
        .filter((n) => n.projectId === projectId && n.kind === 'chapter')
        .slice()
        .sort((a, b) => (a.bookOrder ?? 0) - (b.bookOrder ?? 0)),
    [bookNodes, projectId],
  );

  // Dismiss the popover on outside click or Escape. Mousedown (not click)
  // catches dismissal before the click reaches anything underneath, so a
  // click on a different patch's anchor edit opens that one cleanly.
  useEffect(() => {
    if (!anchorEditing) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const pop = popoverRef.current;
      if (pop && !pop.contains(e.target as Node)) setAnchorEditing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchorEditing(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEditing]);

  const handleChangeAnchor = useCallback(
    async (nextNodeId: string | null) => {
      setAnchorEditing(false);
      if (nextNodeId === patch.sourceNodeId) return;
      try {
        await patchRepoRef.current.update(patch.id, {
          sourceNodeId: nextNodeId,
          sourceBlockId: null,
        });
        syncElementPatchUpdate(patch.id, projectId, {
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

  const anchorLabel = patch.sourceBlockId
    ? sourceMissing
      ? `${patch.sourceNodeTitle ?? '(已删除章节)'} · 原段已删除`
      : `${patch.sourceNodeTitle ?? '(已删除章节)'} · 段`
    : (patch.sourceNodeTitle ?? '无章节归属');

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
    if (patch.sourceBlockId) {
      scrollToBlockWhenReady(patch.sourceNodeId, patch.sourceBlockId);
    }
  }, [
    sourceMissing,
    hasSnapshot,
    patch.sourceNodeId,
    patch.sourceBlockId,
    navigateToNode,
  ]);

  const anchorTitle = sourceMissing
    ? hasSnapshot
      ? `${anchorLabel} · 点击查看原文快照`
      : anchorLabel
    : `来自 ${anchorLabel} · 点击跳转`;

  return (
    <div className={`patch-card${sourceMissing ? ' patch-card--source-missing' : ''}`}>
      <div className="patch-card__head">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="patch-card__toggle"
          aria-label={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {/* Anchor sits left of the title — chapter + 段 read together
            naturally ("from chapter X, paragraph"). Click semantics fork
            on whether the original block still exists (see handleAnchorClick).
            The ✎ next to it re-anchors to a different chapter. */}
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
        <div className="patch-card__anchor-edit-slot" ref={popoverRef}>
          <button
            type="button"
            onClick={() => setAnchorEditing((v) => !v)}
            className="patch-card__anchor-edit"
            title="改章节归属"
            aria-label="编辑来源章节"
            aria-expanded={anchorEditing}
          >
            ✎
          </button>
          {anchorEditing && (
            <div className="patch-card__anchor-pop" role="listbox">
              <div className="patch-card__anchor-pop-kicker">归属到</div>
              <div className="patch-card__anchor-pop-list">
                {chapterOptions.length === 0 && (
                  <div className="patch-card__anchor-pop-empty">本项目还没有章节</div>
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
                      <span className="patch-card__anchor-pop-title">
                        {n.title || '(未命名章节)'}
                      </span>
                      {current && patch.sourceBlockId && (
                        <span className="patch-card__anchor-pop-tail">块级</span>
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
                <span className="patch-card__anchor-pop-title">无章节归属</span>
              </button>
            </div>
          )}
        </div>
        <input
          type="text"
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleSaveTitle}
          placeholder="补丁标题（可选）"
          className="patch-card__title"
        />
        <button
          type="button"
          onClick={handleDelete}
          className="patch-card__delete"
          aria-label="删除补丁"
        >
          ×
        </button>
      </div>
      {!collapsed && sourceMissing && hasSnapshot && snapshotOpen && (
        <div className="patch-card__snapshot">
          <pre className="patch-card__snapshot-body">{patch.sourceBlockText}</pre>
        </div>
      )}
      {!collapsed && (
        <div className="patch-card__body">
          <EditorContent editor={editor} />
        </div>
      )}
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
