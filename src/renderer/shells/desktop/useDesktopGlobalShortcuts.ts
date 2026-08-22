import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import type { NavigateFunction } from 'react-router-dom';
import { focusedLeafOf, SINGLETON_TAB_ID, tabKey, useUiStore } from '../../store/ui-store';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { matchesAccelerator } from '../../lib/shortcuts';
import { getActiveEditor, saveActiveEditor } from '../../lib/active-editor';
import { flushAllYjsDocumentsLocally } from '../../services/yjs-local-durability.service';
import { workspaceUrlFor } from '../../features/workspace/navigation/workspace-route';
import type { WorkspaceNavigator } from '../../features/workspace/navigation/workspace-target';

const log = loglevel.getLogger('DesktopGlobalShortcuts');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

interface DesktopGlobalShortcutOptions {
  projectId: string;
  openFind(editor: Editor): void;
  openGlobalSearch(): void;
  navigator: WorkspaceNavigator;
  navigate: NavigateFunction;
}

export function useDesktopGlobalShortcuts({
  projectId,
  openFind,
  openGlobalSearch,
  navigator,
  navigate,
}: DesktopGlobalShortcutOptions) {
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);
  const lastSingletonShortcut = useRef<{ code: 'Digit1' | 'Digit2'; at: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey) return;
      const dismissSuperView = () => {
        if (activeSuperView !== 'none') setActiveSuperView('none');
      };
      const toggleSuper = (view: 'graph' | 'element' | 'memo-material') => {
        setActiveSuperView(activeSuperView === view ? 'none' : view);
      };
      const maybePromote = (code: 'Digit1' | 'Digit2') => {
        const previous = lastSingletonShortcut.current;
        const now = performance.now();
        if (previous && previous.code === code && now - previous.at <= 500) {
          useUiStore.getState().promoteTab(projectId);
          lastSingletonShortcut.current = null;
        } else {
          lastSingletonShortcut.current = { code, at: now };
        }
      };

      switch (event.code) {
        case 'Digit1':
          event.preventDefault();
          dismissSuperView();
          navigator.open({ entityType: 'dashboard', id: SINGLETON_TAB_ID });
          maybePromote('Digit1');
          return;
        case 'Digit2':
          event.preventDefault();
          dismissSuperView();
          navigator.open({ entityType: 'all-chapters', id: SINGLETON_TAB_ID });
          maybePromote('Digit2');
          return;
        case 'Digit3':
          event.preventDefault();
          toggleSuper('graph');
          return;
        case 'Digit4':
          event.preventDefault();
          toggleSuper('element');
          return;
        case 'Digit5':
          event.preventDefault();
          toggleSuper('memo-material');
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSuperView, navigator, projectId, setActiveSuperView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useUiStore.getState().activeSuperView !== 'none') return;
      const { bindings } = useShortcutsStore.getState();

      if (matchesAccelerator(event, bindings.globalSearch)) {
        event.preventDefault();
        openGlobalSearch();
        return;
      }

      if (matchesAccelerator(event, bindings.findInEditor)) {
        const editor = getActiveEditor();
        if (editor) {
          event.preventDefault();
          openFind(editor);
        }
        return;
      }

      if (matchesAccelerator(event, bindings.saveCurrentEditor)) {
        event.preventDefault();
        void saveActiveEditor()
          .then(() => flushAllYjsDocumentsLocally())
          .catch((error) => log.warn('Save shortcut sync failed:', error));
        return;
      }

      if (matchesAccelerator(event, bindings.toggleBottomTimeline)) {
        event.preventDefault();
        useUiStore.getState().toggleBottomTimelineHidden();
        return;
      }

      if (matchesAccelerator(event, bindings.goBack)) {
        event.preventDefault();
        if (useUiStore.getState().activeSuperView !== 'none') {
          useUiStore.getState().setActiveSuperView('none');
          return;
        }
        navigate(-1);
        return;
      }

      if (matchesAccelerator(event, bindings.goForward)) {
        event.preventDefault();
        navigate(1);
        return;
      }

      if (
        matchesAccelerator(event, bindings.prevTab) ||
        matchesAccelerator(event, bindings.nextTab)
      ) {
        const state = useUiStore.getState();
        const project = state.tabsByProject[projectId];
        if (!project || project.openTabs.length === 0) return;
        event.preventDefault();
        const activeKey = project.activeTabKey;
        const currentIndex = activeKey
          ? project.openTabs.findIndex((tab) => tabKey(tab) === activeKey)
          : -1;
        const direction = matchesAccelerator(event, bindings.nextTab) ? 1 : -1;
        const baseIndex = currentIndex === -1 ? (direction > 0 ? -1 : 0) : currentIndex;
        const nextIndex =
          (baseIndex + direction + project.openTabs.length) % project.openTabs.length;
        const nextTab = project.openTabs[nextIndex];
        if (nextTab.kind === 'split') {
          state.setActiveTab(projectId, { splitId: nextTab.id });
          const target = focusedLeafOf(nextTab);
          const url = workspaceUrlFor(projectId, target);
          if (url) navigate(url);
        } else {
          navigator.activate(nextTab);
        }
      }

      if (matchesAccelerator(event, bindings.closeActiveTab)) {
        const state = useUiStore.getState();
        const project = state.tabsByProject[projectId];
        const activeKey = project?.activeTabKey;
        if (!activeKey) return;
        const activeTab = project.openTabs.find((tab) => tabKey(tab) === activeKey);
        if (!activeTab) return;
        event.preventDefault();
        const closeRef =
          activeTab.kind === 'split'
            ? { splitId: activeTab.id }
            : { entityType: activeTab.entityType, id: activeTab.id };
        const { nextActive } = state.closeTab(projectId, closeRef);
        if (nextActive) {
          navigator.open({ entityType: nextActive.entityType, id: nextActive.id });
        } else {
          navigate(`/project/${projectId}`, { replace: true });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, navigator, openFind, openGlobalSearch, projectId]);
}
