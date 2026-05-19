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
    case 'node-editor':
    case 'storyline-editor':
    case 'all-chapters-editor':
      return {
        view,
        activeEntityType: 'node' as const,
      };
    case 'element-editor':
    case 'category-editor':
      return {
        view,
        activeEntityType: 'element' as const,
      };
    case 'project-home':
    case 'project-dashboard':
    default:
      return {
        view,
        activeEntityType: 'none' as const,
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
  const { projectId, navigateToNode, navigateToElement } = useProjectNavigation();
  const runtime = useMemo(() => buildRuntime(view), [view]);

  const setEditorRuntime = useUiStore((state) => state.setEditorRuntime);
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const setElementSelection = useUiStore((state) => state.setElementSelection);
  const setNodeActiveStorylineId = useUiStore((state) => state.setNodeActiveStorylineId);
  const setElementActiveCategoryId = useUiStore((state) => state.setElementActiveCategoryId);
  const openEntityTab = useUiStore((state) => state.openEntityTab);
  const setActiveTab = useUiStore((state) => state.setActiveTab);
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
    if (nodeSelectedFrom !== 'ui') return;
    if (!nodeSelectedId) return;
    if (nodeSelectedId === nodeId) return;
    // In all-chapters mode, a UI selection means "scroll to this chapter" —
    // never a route change. The view itself watches nodeUi.selectedId and
    // scrolls; leaving the URL alone keeps the long-scroll view mounted.
    if (view === 'all-chapters-editor') return;
    navigateToNode(nodeSelectedId);
  }, [nodeSelectedFrom, nodeSelectedId, nodeId, navigateToNode, view]);

  useEffect(() => {
    if (elementSelectedFrom !== 'ui') return;
    if (!elementSelectedId) return;
    if (elementSelectedId === elementId) return;
    navigateToElement(elementSelectedId);
  }, [elementSelectedFrom, elementSelectedId, elementId, navigateToElement]);

  // URL → tab sync. Ensures the entity in the URL has an open tab (idempotent
  // for already-open tabs — preserves dedicated state) and is the active tab.
  // Dashboard routes clear the active tab without touching the open list.
  useEffect(() => {
    if (!projectId) return;
    if (view === 'node-editor' && nodeId) {
      openEntityTab(projectId, { entityType: 'node', id: nodeId }, { preview: true });
    } else if (view === 'storyline-editor' && storylineId) {
      openEntityTab(projectId, { entityType: 'storyline', id: storylineId }, { preview: true });
    } else if (view === 'element-editor' && elementId) {
      openEntityTab(projectId, { entityType: 'element', id: elementId }, { preview: true });
    } else if (view === 'category-editor' && categoryId) {
      openEntityTab(
        projectId,
        { entityType: 'category', id: safeDecodeURIComponent(categoryId) },
        { preview: true },
      );
    } else {
      setActiveTab(projectId, null);
    }
  }, [
    projectId,
    view,
    nodeId,
    storylineId,
    elementId,
    categoryId,
    openEntityTab,
    setActiveTab,
  ]);

  return <>{children}</>;
}
