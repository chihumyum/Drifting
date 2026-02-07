import { ReactNode, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useUiStore, type EditorShellView } from '../store/ui-store';

interface EditorShellProps {
  view: EditorShellView;
  children: ReactNode;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildRuntime(view: EditorShellView) {
  switch (view) {
    case 'all-nodes-editor':
      return {
        view,
        activeEntityType: 'node' as const,
        isAllNodesEditor: true,
        isAllElementsEditor: false,
        shouldNavigateOnNodeSelect: false,
        shouldNavigateOnElementSelect: true,
      };
    case 'all-elements-editor':
      return {
        view,
        activeEntityType: 'element' as const,
        isAllNodesEditor: false,
        isAllElementsEditor: true,
        shouldNavigateOnNodeSelect: true,
        shouldNavigateOnElementSelect: false,
      };
    case 'node-editor':
    case 'storyline-editor':
      return {
        view,
        activeEntityType: 'node' as const,
        isAllNodesEditor: false,
        isAllElementsEditor: false,
        shouldNavigateOnNodeSelect: true,
        shouldNavigateOnElementSelect: true,
      };
    case 'element-editor':
    case 'category-editor':
      return {
        view,
        activeEntityType: 'element' as const,
        isAllNodesEditor: false,
        isAllElementsEditor: false,
        shouldNavigateOnNodeSelect: true,
        shouldNavigateOnElementSelect: true,
      };
    case 'project-home':
    case 'project-dashboard':
    default:
      return {
        view,
        activeEntityType: 'none' as const,
        isAllNodesEditor: false,
        isAllElementsEditor: false,
        shouldNavigateOnNodeSelect: true,
        shouldNavigateOnElementSelect: true,
      };
  }
}

export function EditorShell({ view, children }: EditorShellProps) {
  const { nodeId, elementId, storylineId, categoryId } = useParams<{
    nodeId?: string;
    elementId?: string;
    storylineId?: string;
    categoryId?: string;
  }>();
  const { navigateToNode, navigateToElement } = useProjectNavigation();
  const runtime = useMemo(() => buildRuntime(view), [view]);

  const setEditorRuntime = useUiStore((state) => state.setEditorRuntime);
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const setElementSelection = useUiStore((state) => state.setElementSelection);
  const setNodeActiveStorylineId = useUiStore((state) => state.setNodeActiveStorylineId);
  const setElementActiveCategoryId = useUiStore((state) => state.setElementActiveCategoryId);
  const nodeSelectedId = useUiStore((state) => state.nodeUi.selectedId);
  const nodeSelectedFrom = useUiStore((state) => state.nodeUi.selectedFrom);
  const elementSelectedId = useUiStore((state) => state.elementUi.selectedId);
  const elementSelectedFrom = useUiStore((state) => state.elementUi.selectedFrom);

  useEffect(() => {
    setEditorRuntime(runtime);
  }, [runtime, setEditorRuntime]);

  useEffect(() => {
    if (nodeId) {
      setNodeSelection(nodeId, 'route');
    }
  }, [nodeId, setNodeSelection]);

  useEffect(() => {
    if (elementId) {
      setElementSelection(elementId, 'route');
    }
  }, [elementId, setElementSelection]);

  useEffect(() => {
    if (view === 'storyline-editor') {
      setNodeActiveStorylineId(storylineId ?? null);
      return;
    }
    setNodeActiveStorylineId(null);
  }, [view, storylineId, setNodeActiveStorylineId]);

  useEffect(() => {
    if (view === 'category-editor') {
      setElementActiveCategoryId(categoryId ? safeDecodeURIComponent(categoryId) : null);
      return;
    }
    setElementActiveCategoryId(null);
  }, [view, categoryId, setElementActiveCategoryId]);

  useEffect(() => {
    if (!runtime.shouldNavigateOnNodeSelect) return;
    if (nodeSelectedFrom !== 'ui') return;
    if (!nodeSelectedId) return;
    if (nodeSelectedId === nodeId) return;
    navigateToNode(nodeSelectedId);
  }, [
    runtime.shouldNavigateOnNodeSelect,
    nodeSelectedFrom,
    nodeSelectedId,
    nodeId,
    navigateToNode,
  ]);

  useEffect(() => {
    if (!runtime.shouldNavigateOnElementSelect) return;
    if (elementSelectedFrom !== 'ui') return;
    if (!elementSelectedId) return;
    if (elementSelectedId === elementId) return;
    navigateToElement(elementSelectedId);
  }, [
    runtime.shouldNavigateOnElementSelect,
    elementSelectedFrom,
    elementSelectedId,
    elementId,
    navigateToElement,
  ]);

  return <>{children}</>;
}
