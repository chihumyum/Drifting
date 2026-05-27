import { useCallback, useMemo, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import {
  createElementPatchRepository,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
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

  // Source-chapter picker: opens a dropdown listing every chapter in the
  // project plus an "unaffiliated" option. Changing the chapter resets
  // sourceBlockId to null — block ids are chapter-scoped, so keeping the
  // old block id under a new chapter would point nowhere.
  const [anchorEditing, setAnchorEditing] = useState(false);
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

  const anchorLabel = patch.sourceBlockId
    ? `${patch.sourceNodeTitle ?? '(已删除章节)'} · 段`
    : (patch.sourceNodeTitle ?? '无章节归属');

  return (
    <div className="patch-card">
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
            naturally ("from chapter X, paragraph"). Click to navigate.
            The native <select> next to it lets the user re-anchor to a
            different chapter (or detach to floating). Block-id is reset
            when chapter changes — see handleChangeAnchor. */}
        {patch.sourceNodeId ? (
          <button
            type="button"
            onClick={() => patch.sourceNodeId && navigateToNode(patch.sourceNodeId)}
            className="patch-card__anchor-link"
            title={`来自 ${anchorLabel} · 点击跳转`}
          >
            {anchorLabel}
          </button>
        ) : (
          <span className="patch-card__anchor-empty" title={anchorLabel}>
            {anchorLabel}
          </span>
        )}
        {anchorEditing ? (
          <select
            autoFocus
            value={patch.sourceNodeId ?? ''}
            onChange={(e) => void handleChangeAnchor(e.target.value || null)}
            onBlur={() => setAnchorEditing(false)}
            className="patch-card__anchor-link"
            style={{ background: 'transparent', border: 0, outline: 0, cursor: 'pointer' }}
          >
            <option value="">（无章节归属）</option>
            {chapterOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title || '(未命名章节)'}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setAnchorEditing(true)}
            className="patch-card__anchor-link"
            title="改章节归属"
            style={{ padding: '0 4px' }}
            aria-label="编辑来源章节"
          >
            ✎
          </button>
        )}
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
      {!collapsed && (
        <div className="patch-card__body">
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
}
