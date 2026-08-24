import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  useProjectTabs,
  useUiStore,
  tabKey,
  focusedLeafOf,
  CREATE_TAB_ID,
  SINGLETON_TAB_ID,
  type TabRef,
} from '../../store/ui-store';

// Pathname matchers for the project-scoped entity routes. Layout sits at
// /project/:projectId, so useParams() at this level only carries projectId
// — child route params (nodeId / categoryId / etc.) aren't visible from an
// ancestor in react-router. Parse the pathname ourselves.
const NODE_RE = /^\/project\/[^/]+\/editor\/([^/]+)$/;
const STORYLINE_RE = /^\/project\/[^/]+\/editor\/storyline\/([^/]+)$/;
const ELEMENT_RE = /^\/project\/[^/]+\/element\/([^/]+)$/;
const CATEGORY_RE = /^\/project\/[^/]+\/category\/([^/]+)$/;

// Two-way sync between the URL and the focused leaf of the active tab.
// Mounted at the Layout level so it runs regardless of whether the Outlet
// is currently rendering — in split mode, the matched route's element does
// NOT mount (EditorMainArea suppresses Outlet), so any sync that lived in
// EditorShell wouldn't fire.
//
// Direction:
//   • If the URL points at an entity that doesn't match the focused leaf
//     of the active tab, treat the URL as authoritative — the user clicked
//     a link, breadcrumb, etc. In split mode, replace the focused side with
//     the URL entity (openEntityTab handles this). In single-pane mode,
//     fall back to opening the entity as a tab.
//   • Otherwise, mirror the focused leaf's id into nodeUi/elementUi
//     selection state so the sidebar / timeline highlight follows it. This
//     replaces what EditorShell does in single-pane mode (which still also
//     runs, harmlessly redundant) and covers split mode (where EditorShell
//     doesn't mount).
//
// We deliberately do NOT push the focused leaf back into the URL on tab
// activations — every call site that changes focus already calls navigate()
// itself (TopTimeline tab/sub-label clicks, PaneWrapper mouseDown handler).
// Pushing here would create circular updates with the same destination.
export function useSyncSplitFocusedUrl(): void {
  const { projectId } = useParams<{ projectId?: string }>();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const location = useLocation();
  const navigate = useNavigate();
  const setNodeSelection = useUiStore((s) => s.setNodeSelection);
  const setElementSelection = useUiStore((s) => s.setElementSelection);
  const openEntityTab = useUiStore((s) => s.openEntityTab);
  const activateExistingTarget = useUiStore((s) => s.activateExistingTarget);
  const nodeSelectedId = useUiStore((s) => s.nodeUi.selectedId);
  const nodeSelectedFrom = useUiStore((s) => s.nodeUi.selectedFrom);
  const elementSelectedId = useUiStore((s) => s.elementUi.selectedId);
  const elementSelectedFrom = useUiStore((s) => s.elementUi.selectedFrom);

  // UI-source selection (BottomTimeline node clicks etc.) → navigate.
  // Replaces EditorShell's "selectedFrom === 'ui' → navigateToX" effect so
  // the same logic fires in split mode (where EditorShell isn't mounted).
  //
  // Tabs / active key are read via getState() rather than subscribed in
  // deps. The effect should only fire when the *selection* changes — if
  // openTabs were in the dep list, closeTab() would re-trigger this and,
  // when an earlier UI-source selection still pointed at the just-closed
  // entity, immediately re-open it (the "click X twice to close" bug).
  useEffect(() => {
    if (!projectId) return;
    if (nodeSelectedFrom !== 'ui' || !nodeSelectedId) return;
    const project = useUiStore.getState().tabsByProject[projectId];
    const active = project?.openTabs.find((t) => tabKey(t) === project.activeTabKey);
    const focused = active ? focusedLeafOf(active) : null;
    if (focused?.entityType === 'node' && focused.id === nodeSelectedId) return;
    const target = { entityType: 'node' as const, id: nodeSelectedId };
    if (!activateExistingTarget(projectId, target)) {
      openEntityTab(projectId, target, { preview: true });
    }
    navigate(`/project/${projectId}/editor/${nodeSelectedId}`);
  }, [activateExistingTarget, nodeSelectedFrom, nodeSelectedId, projectId, openEntityTab, navigate]);

  useEffect(() => {
    if (!projectId) return;
    if (elementSelectedFrom !== 'ui' || !elementSelectedId) return;
    const project = useUiStore.getState().tabsByProject[projectId];
    const active = project?.openTabs.find((t) => tabKey(t) === project.activeTabKey);
    const focused = active ? focusedLeafOf(active) : null;
    if (focused?.entityType === 'element' && focused.id === elementSelectedId) return;
    const target = { entityType: 'element' as const, id: elementSelectedId };
    if (!activateExistingTarget(projectId, target)) {
      openEntityTab(projectId, target, { preview: true });
    }
    navigate(`/project/${projectId}/element/${elementSelectedId}`);
  }, [activateExistingTarget, elementSelectedFrom, elementSelectedId, projectId, openEntityTab, navigate]);

  // Track whether the most recent render came from "tabs were just emptied".
  // Zustand's set() and React Router's setState aren't guaranteed to commit
  // in the same render pass when called back-to-back from the same event
  // handler (Zustand notifies via useSyncExternalStore, Router via context
  // updates) — so closing the last tab + navigating to a blank URL can
  // briefly produce an inconsistent state where openTabs=[] but URL still
  // points at the just-closed entity. Without the guard below the next
  // line, the "no active + URL has entity → open it" branch would observe
  // that stale URL and re-create the tab we just closed, which is the
  // "click X twice to close" bug.
  const prevOpenTabsLenRef = useRef(openTabs.length);
  const prevActiveTabKeyRef = useRef(activeTabKey);
  const prevFocusedRef = useRef<TabRef | null>(null);

  useEffect(() => {
    const prevLen = prevOpenTabsLenRef.current;
    const previousActiveTabKey = prevActiveTabKeyRef.current;
    prevOpenTabsLenRef.current = openTabs.length;
    prevActiveTabKeyRef.current = activeTabKey;
    const justEmptied = prevLen > 0 && openTabs.length === 0;

    if (!projectId) {
      prevFocusedRef.current = null;
      return;
    }
    const active = openTabs.find((t) => tabKey(t) === activeTabKey);
    const urlEntity = parseEntityFromPath(location.pathname, projectId);
    const projectRoot = `/project/${projectId}`;
    const atProjectHome = location.pathname === projectRoot || location.pathname === `${projectRoot}/`;
    const atCreateRoute = location.pathname === `${projectRoot}/new`;
    const resumeEntry =
      (location.state as { projectEntry?: unknown } | null)?.projectEntry ===
      'resume-last-content';

    if (atProjectHome && resumeEntry) return;

    // No active tab and URL points at an entity → open it. This is the
    // "user typed a URL / followed a deep link" path. Skipped on the
    // single render where tabs just dropped to zero — see the ref comment
    // above; otherwise we'd race the URL update and re-spawn the tab.
    if (!active && urlEntity && !justEmptied) {
      if (!activateExistingTarget(projectId, urlEntity)) {
        openEntityTab(projectId, urlEntity, { preview: true });
      }
      mirrorSelection(urlEntity, setNodeSelection, setElementSelection);
      prevFocusedRef.current = urlEntity;
      return;
    }
    if (!active) {
      if (atCreateRoute) navigate(projectRoot, { replace: true });
      // No active tab — the last tab was just closed, or a delete flow
      // emptied the project. Nothing is focused, so clear any lingering
      // node/element selection. Otherwise nodeUi/elementUi.selectedId keeps
      // pointing at the just-closed entity and ChapterPanel + BottomTimeline
      // render a stale "selected" cell/node forever (the residual-highlight
      // bug). Guard on getState() to skip redundant store writes when there's
      // nothing selected.
      const ui = useUiStore.getState();
      if (ui.nodeUi.selectedId) setNodeSelection(null);
      if (ui.elementUi.selectedId) setElementSelection(null);
      prevFocusedRef.current = null;
      return;
    }

    if (active.kind === 'create') {
      const previousFocused = prevFocusedRef.current;
      if (urlEntity && previousFocused && sameEntity(urlEntity, previousFocused)) {
        navigate(`${projectRoot}/new`, { replace: true });
      } else if (urlEntity) {
        // Back/forward, a deep link, or another entity navigation leaves the
        // draft open but moves focus to the requested real entity.
        if (!activateExistingTarget(projectId, urlEntity)) {
          openEntityTab(projectId, urlEntity, { preview: true });
        }
        mirrorSelection(urlEntity, setNodeSelection, setElementSelection);
        prevFocusedRef.current = urlEntity;
        return;
      }
      if (atProjectHome) {
        // Opening Universal Create from Home updates the external tab store
        // and React Router independently. The store notification can render
        // first, leaving one frame with "newly active create tab + old Home
        // URL". That is a forward transition, not a request to return Home.
        // Let the already-requested /new navigation commit; a genuine
        // browser/history return from /new has create active in both renders
        // and still clears the active tab below.
        if (
          isCreateActivationFromProjectHome({
            atProjectHome,
            previousActiveTabKey,
            activeTabKey,
          })
        ) {
          prevFocusedRef.current = null;
          return;
        }
        useUiStore.getState().setActiveTab(projectId, null);
        prevFocusedRef.current = null;
        return;
      }
      if (!atCreateRoute) navigate(`${projectRoot}/new`, { replace: true });
      const ui = useUiStore.getState();
      if (ui.nodeUi.selectedId) setNodeSelection(null);
      if (ui.elementUi.selectedId) setElementSelection(null);
      prevFocusedRef.current = null;
      return;
    }

    const focused = focusedLeafOf(active);
    if (!focused) return;
    const prevFocused = prevFocusedRef.current;
    const focusedChanged =
      prevFocused !== null && !sameEntity(prevFocused, focused);

    // The bare project URL is authoritative Project Home. History navigation
    // can land here while a content tab is still selected, so clear only the
    // active selection and keep the tab strip/session intact.
    if (atProjectHome) {
      useUiStore.getState().setActiveTab(projectId, null);
      const ui = useUiStore.getState();
      if (ui.nodeUi.selectedId) setNodeSelection(null);
      if (ui.elementUi.selectedId) setElementSelection(null);
      prevFocusedRef.current = null;
      return;
    }
    if (atCreateRoute) {
      if (
        isContentActivationFromCreateRoute({
          atCreateRoute,
          previousActiveTabKey,
          activeTabKey,
        })
      ) {
        const expected = expectedPathnameFor(projectId, focused);
        if (expected) navigate(expected, { replace: true });
        mirrorSelection(focused, setNodeSelection, setElementSelection);
        prevFocusedRef.current = focused;
        return;
      }
      navigate(projectRoot, { replace: true });
      return;
    }

    if (
      urlEntity &&
      !sameEntity(urlEntity, focused)
    ) {
      // closeTab()/setActiveTab() update the tab store synchronously, while
      // navigate() lands through React Router. On the render in between,
      // the active leaf is already the next tab but location.pathname can
      // still point at the previous one. Treat that URL as stale; otherwise
      // openEntityTab(...preview: true) re-creates the just-closed dedicated
      // tab as a preview, which makes closing appear to require two actions.
      if (focusedChanged && sameEntity(urlEntity, prevFocused)) {
        const expected = expectedPathnameFor(projectId, focused);
        if (expected && location.pathname !== expected) {
          navigate(expected, { replace: true });
        }
        mirrorSelection(focused, setNodeSelection, setElementSelection);
        prevFocusedRef.current = focused;
        return;
      }

      // For a split, the URL might be pointing at the *non-focused* side —
      // this happens any time something changed the focused side without
      // immediately pushing a URL, the most common case being
      // splitActiveWith() (drag-to-split / context-menu split) which
      // creates a new split with focused = source while the URL still
      // reflects the previously-active leaf. If we blindly treated URL as
      // authoritative here we'd stomp the just-created focused side and
      // duplicate the URL's leaf into both panes.
      //
      // So: when the URL matches the non-focused side of the split, this
      // is a "focused side just changed; URL is stale" scenario — push
      // focused → URL instead of pulling URL → focused. Otherwise the URL
      // points at a third entity, which means the user actually navigated
      // somewhere new (link / breadcrumb / back-forward) and we replace
      // the focused side with that.
      if (active.kind === 'split') {
        const other = active.focused === 'left' ? active.right : active.left;
        if (sameEntity(urlEntity, other)) {
          const expected = expectedPathnameFor(projectId, focused);
          if (expected && location.pathname !== expected) {
            navigate(expected, { replace: true });
          }
          mirrorSelection(focused, setNodeSelection, setElementSelection);
          prevFocusedRef.current = focused;
          return;
        }
      }
      if (!activateExistingTarget(projectId, urlEntity)) {
        openEntityTab(projectId, urlEntity, { preview: true });
      }
      mirrorSelection(urlEntity, setNodeSelection, setElementSelection);
      prevFocusedRef.current = urlEntity;
      return;
    }

    // URL matches focused leaf — just mirror its id into selection state.
    mirrorSelection(focused, setNodeSelection, setElementSelection);
    prevFocusedRef.current = focused;
  }, [
    activeTabKey,
    activateExistingTarget,
    openTabs,
    location.pathname,
    location.state,
    projectId,
    openEntityTab,
    navigate,
    setNodeSelection,
    setElementSelection,
  ]);
}

export function isCreateActivationFromProjectHome({
  atProjectHome,
  previousActiveTabKey,
  activeTabKey,
}: {
  atProjectHome: boolean;
  previousActiveTabKey: string | null;
  activeTabKey: string | null;
}): boolean {
  return (
    atProjectHome &&
    activeTabKey !== null &&
    previousActiveTabKey !== activeTabKey
  );
}

export function isContentActivationFromCreateRoute({
  atCreateRoute,
  previousActiveTabKey,
  activeTabKey,
}: {
  atCreateRoute: boolean;
  previousActiveTabKey: string | null;
  activeTabKey: string | null;
}): boolean {
  return (
    atCreateRoute &&
    previousActiveTabKey === `create:${CREATE_TAB_ID}` &&
    activeTabKey !== null &&
    activeTabKey !== previousActiveTabKey
  );
}

function sameEntity(a: TabRef, b: TabRef): boolean {
  return a.entityType === b.entityType && a.id === b.id;
}

function mirrorSelection(
  ref: TabRef,
  setNodeSelection: (id: string | null, source?: 'route' | 'ui' | 'system') => void,
  setElementSelection: (id: string | null, source?: 'route' | 'ui' | 'system') => void,
): void {
  if (ref.entityType === 'node') setNodeSelection(ref.id, 'system');
  else if (ref.entityType === 'element') setElementSelection(ref.id, 'system');
  else {
    // all-chapters / storyline / category aren't entity
    // selections — the left sidebar / timeline listen to nodeUi/elementUi
    // only. Clear any lingering node/element highlight so focusing one of
    // these (e.g. after closing a node tab whose successor is a storyline
    // tab) doesn't leave the previously-focused chapter/element selected.
    const ui = useUiStore.getState();
    if (ui.nodeUi.selectedId) setNodeSelection(null);
    if (ui.elementUi.selectedId) setElementSelection(null);
  }
}

// Build the pathname a TabRef corresponds to. Mirrors the URL switch in
// useProjectNavigation but available in this file so we don't pull in
// React Router context for a pure string operation. Returns null for
// refs that don't map to a known route.
function expectedPathnameFor(projectId: string, ref: TabRef): string | null {
  switch (ref.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${ref.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${ref.id}`;
    case 'element':
      return `/project/${projectId}/element/${ref.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(ref.id)}`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
  }
}

// Map the current location.pathname back to a TabRef. Returns null for
// paths that aren't tab-bearing (e.g. /project/p — the bare project URL —
// or anything that doesn't match an entity route).
function parseEntityFromPath(pathname: string, projectId: string): TabRef | null {
  if (pathname === `/project/${projectId}/editor/all`) {
    return { entityType: 'all-chapters', id: SINGLETON_TAB_ID };
  }
  // Order matters: storyline route nests under /editor/, so check it before
  // the bare /editor/:nodeId regex. The `/editor/all` case is handled by
  // the singleton check above; NODE_RE requires exactly one segment after
  // /editor/ which excludes storyline subpaths automatically.
  const sl = STORYLINE_RE.exec(pathname);
  if (sl) return { entityType: 'storyline', id: sl[1] };
  const n = NODE_RE.exec(pathname);
  if (n) return { entityType: 'node', id: n[1] };
  const el = ELEMENT_RE.exec(pathname);
  if (el) return { entityType: 'element', id: el[1] };
  const cat = CATEGORY_RE.exec(pathname);
  if (cat) {
    let id = cat[1];
    try {
      id = decodeURIComponent(cat[1]);
    } catch {
      /* leave raw */
    }
    return { entityType: 'category', id };
  }
  return null;
}
