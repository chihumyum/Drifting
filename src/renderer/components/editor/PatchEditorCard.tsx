import { useCallback, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import {
  createElementPatchRepository,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { createReferenceRepository } from '../../sqlite-repo/reference-repo';
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
  const [collapsed, setCollapsed] = useState(true);
  const patchRepoRef = useRef(createElementPatchRepository());
  const referenceRepoRef = useRef(createReferenceRepository());

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
    editorClass: 'prose prose-sm max-w-none focus:outline-none min-h-[120px]',
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
      // Also clear any inline refs emitted from this patch.
      await referenceRepoRef.current.deleteAllForSource('patch', patch.id);
      onDelete?.();
    } catch (error) {
      log.error('Failed to delete patch:', error);
    }
  }, [patch.id, onDelete]);

  const anchorLabel = patch.sourceBlockId
    ? `${patch.sourceNodeTitle ?? '(已删除章节)'} · 段`
    : (patch.sourceNodeTitle ?? '无章节归属');

  return (
    <div className="patch-card border border-gray-700 rounded p-3 bg-gray-850">
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-gray-400 hover:text-gray-200 text-xs"
          aria-label={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <input
          type="text"
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleSaveTitle}
          placeholder="补丁标题（可选）"
          className="flex-1 bg-transparent text-sm text-gray-100 focus:outline-none placeholder-gray-600"
        />
        <span className="text-[10px] text-gray-500 max-w-[160px] truncate">
          {patch.sourceBlockId ? '块级' : patch.sourceNodeId ? '章级' : '游离'}
        </span>
        <button
          type="button"
          onClick={handleDelete}
          className="text-gray-500 hover:text-red-400 text-xs"
          aria-label="删除补丁"
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-2">
        <span>来自:</span>
        {patch.sourceNodeId ? (
          <button
            type="button"
            onClick={() => patch.sourceNodeId && navigateToNode(patch.sourceNodeId)}
            className="underline hover:text-gray-300"
          >
            {anchorLabel}
          </button>
        ) : (
          <span className="italic">{anchorLabel}</span>
        )}
      </div>
      {!collapsed && (
        <div className="patch-content border-t border-gray-800 pt-2">
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
}
