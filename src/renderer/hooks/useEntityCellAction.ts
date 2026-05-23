import { useCallback } from 'react';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useUiStore, type TabEntityType } from '../store/ui-store';
import { useBookNode } from '../usecase/useBookNode';
import { useBookElement } from '../usecase/useBookElement';
import { useElementCategory } from '../usecase/useElementCategory';
import { useStoryline } from '../usecase/useStoryline';
import {
  CHAPTER_WRITING_STATUSES,
  DRIFT_STATUSES,
  isDrift,
  type WritingStatus,
} from '../domain/book-node';
import {
  CONVERT_DRIFT_TO_CHAPTER_ACTION,
  CONVERT_DRIFT_TO_ELEMENT_ACTION,
  SET_STATUS_ACTION_PREFIX,
} from '../components/editor/EditorTopBar';
import { useProjectNavigation } from './useProjectNavigation';

const log = loglevel.getLogger('useEntityCellAction');
log.setLevel(loglevel.levels.ERROR);

interface DispatchInput {
  entityType: TabEntityType;
  id: string;
  action: string;
}

// Single dispatcher used by every left-sidebar panel's context menu. Direct
// actions (delete, status flips, edit-storyline modal) execute in place so
// the menu doesn't need a side trip through the editor view. Actions that
// depend on editor-local UI state (categoryPicker, drift conversions) get
// queued via `enqueueEntityAction` and the navigation opens the entity tab;
// the editor view consumes the queued action on mount via `consumeEntityAction`.
export function useEntityCellAction() {
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id);
  const { bookNodes, bookElements, bookElementCategories } = useDataStore();
  const setChapterStorylineEditorNodeId = useUiStore(
    (s) => s.setChapterStorylineEditorNodeId,
  );
  const enqueueEntityAction = useUiStore((s) => s.enqueueEntityAction);

  const { updateNode, deleteNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { removeElement, updateElement } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { deleteCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { deleteStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  return useCallback(
    async ({ entityType, id, action }: DispatchInput) => {
      try {
        // ----- Direct (no editor needed) -----
        if (entityType === 'node') {
          const node = bookNodes.find((n) => n.id === id);
          if (!node) return;

          if (action === 'editNodeStorylines') {
            setChapterStorylineEditorNodeId(id);
            return;
          }
          if (action === 'deleteNode') {
            const confirmed = window.confirm(`Delete node "${node.title}"?`);
            if (!confirmed) return;
            await deleteNode(id);
            return;
          }
          if (action.startsWith(SET_STATUS_ACTION_PREFIX)) {
            const next = action.slice(SET_STATUS_ACTION_PREFIX.length) as WritingStatus;
            const allowed = isDrift(node) ? DRIFT_STATUSES : CHAPTER_WRITING_STATUSES;
            if (!allowed.includes(next as never) || next === node.writingStatus) return;
            await updateNode(id, { writingStatus: next });
            return;
          }
          if (
            action === CONVERT_DRIFT_TO_CHAPTER_ACTION ||
            action === CONVERT_DRIFT_TO_ELEMENT_ACTION
          ) {
            // The conversion picker lives inside NodeEditorView's local
            // state. Open the editor tab and queue the action so the view
            // pops the modal once mounted.
            enqueueEntityAction(entityType, id, action);
            openEntity({ entityType: 'node', id }, { preview: false });
            return;
          }
          return;
        }

        if (entityType === 'element') {
          const element = bookElements.find((e) => e.id === id);
          if (!element) return;
          if (action === 'deleteElement') {
            const confirmed = window.confirm(`Delete element "${element.name}"?`);
            if (!confirmed) return;
            await removeElement(id);
            return;
          }
          if (action === 'categoryPicker') {
            // Picker modal is editor-local — queue + navigate so the view
            // can render the same dialog it would on its own three-dot menu.
            enqueueEntityAction(entityType, id, action);
            openEntity({ entityType: 'element', id }, { preview: false });
            return;
          }
          if (action === 'groupPicker') {
            // groupName is a free-form label (no separate entity), so a
            // plain prompt suffices — keeps the action self-contained and
            // identical from every surface (left panel, super-element card,
            // editor top bar). Empty string clears the group.
            const next = window.prompt(
              '分组名称（留空 = 不分组）',
              element.groupName ?? '',
            );
            if (next == null) return;
            const trimmed = next.trim();
            const nextGroup = trimmed === '' ? null : trimmed;
            if (nextGroup === (element.groupName ?? null)) return;
            await updateElement(id, { groupName: nextGroup });
            return;
          }
          return;
        }

        if (entityType === 'category') {
          const category = bookElementCategories.find((c) => c.id === id);
          if (!category) return;
          if (action === 'deleteCategory') {
            const confirmed = window.confirm(
              `Delete category "${category.name}"?\n\nElements in this category will move to "未分类" (categoryId becomes empty).`,
            );
            if (!confirmed) return;
            await deleteCategory(id);
            return;
          }
          return;
        }

        if (entityType === 'storyline') {
          if (action === 'deleteStoryline') {
            const storyline = useDataStore.getState().storylines.find((s) => s.id === id);
            if (!storyline) return;
            const confirmed = window.confirm(`Delete storyline "${storyline.name}"?`);
            if (!confirmed) return;
            await deleteStoryline(id);
            return;
          }
          return;
        }
      } catch (error) {
        log.error('Entity cell action failed:', error);
        alert('Action failed. Please try again.');
      }
    },
    [
      bookNodes,
      bookElements,
      bookElementCategories,
      setChapterStorylineEditorNodeId,
      enqueueEntityAction,
      openEntity,
      updateNode,
      deleteNode,
      removeElement,
      deleteCategory,
      deleteStoryline,
    ],
  );
}
