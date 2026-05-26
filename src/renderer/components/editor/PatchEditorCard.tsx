import { useCallback, useRef, useState } from 'react';
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
  // handled inside useEntityEditor; we just write the doc back to the row.
  const handlePersist = useCallback(
    (editor: Editor) => {
      const contentJson = JSON.stringify(editor.getJSON());
      void patchRepoRef.current
        .update(patch.id, { contentJson })
        .then(() => onChange?.())
        .catch((error) => log.error('Failed to save patch content:', error));
    },
    [patch.id, onChange],
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
      await patchRepoRef.current.update(patch.id, { title: titleValue || null });
      onChange?.();
    } catch (error) {
      log.error('Failed to save patch title:', error);
    }
  }, [patch.id, patch.title, titleValue, onChange]);

  const handleDelete = useCallback(async () => {
    try {
      await patchRepoRef.current.delete(patch.id);
      // Also clear any inline mentions emitted from this patch.
      await mentionRepoRef.current.deleteAllForSource('patch', patch.id);
      onDelete?.();
    } catch (error) {
      log.error('Failed to delete patch:', error);
    }
  }, [patch.id, onDelete]);

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
            naturally ("from chapter X, paragraph"). Title is now the
            flex-grow center; delete still pins right. */}
        {patch.sourceNodeId ? (
          <button
            type="button"
            onClick={() => patch.sourceNodeId && navigateToNode(patch.sourceNodeId)}
            className="patch-card__anchor-link"
            title={`来自 ${anchorLabel}`}
          >
            {anchorLabel}
          </button>
        ) : (
          <span className="patch-card__anchor-empty" title={anchorLabel}>
            {anchorLabel}
          </span>
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
