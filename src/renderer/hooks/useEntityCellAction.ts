import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
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
import { requestConfirmation } from '../store/confirmation-store';

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
  const { t } = useTranslation();
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id);
  const { bookNodes, bookElements, bookElementCategories } = useDataStore();
  const setChapterStorylineEditorNodeId = useUiStore((s) => s.setChapterStorylineEditorNodeId);
  const enqueueEntityAction = useUiStore((s) => s.enqueueEntityAction);

  const { updateNode, deleteNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { removeElement } = useBookElement({
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
            const confirmed = await requestConfirmation(
              t('entityCellAction.confirmDeleteNode', { name: node.title }),
            );
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
            const confirmed = await requestConfirmation(
              t('entityCellAction.confirmDeleteElement', { name: element.name }),
            );
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
            // Group modal lives in ElementEditorView; the native client does
            // not use window.prompt. Queue + open the element tab so the view
            // pops the same modal it would on its own three-dot menu.
            enqueueEntityAction(entityType, id, action);
            openEntity({ entityType: 'element', id }, { preview: false });
            return;
          }
          return;
        }

        if (entityType === 'category') {
          const category = bookElementCategories.find((c) => c.id === id);
          if (!category) return;
          if (action === 'deleteCategory') {
            const confirmed = await requestConfirmation(
              t('entityCellAction.confirmDeleteCategory', { name: category.name }),
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
            const confirmed = await requestConfirmation(
              t('entityCellAction.confirmDeleteStoryline', { name: storyline.name }),
            );
            if (!confirmed) return;
            await deleteStoryline(id);
            return;
          }
          return;
        }
      } catch (error) {
        log.error('Entity cell action failed:', error);
        alert(t('entityCellAction.actionFailed'));
      }
    },
    [
      t,
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
