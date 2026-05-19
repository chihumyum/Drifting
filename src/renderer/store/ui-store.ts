import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarType = 'left' | 'right';

export type TabEntityType =
  | 'node'
  | 'storyline'
  | 'element'
  | 'category'
  // Singleton tabs that don't correspond to a user-entity. Each project has
  // at most one of each; their id is the constant SINGLETON_TAB_ID. Routed
  // to /home and /editor/all respectively.
  | 'dashboard'
  | 'all-chapters';

// Stable id used for singleton (per-project, one-of-a-kind) tabs. Pairing
// with the entityType discriminator yields a unique tabKey within the project.
export const SINGLETON_TAB_ID = 'self';

export function isSingletonTabType(t: TabEntityType): boolean {
  return t === 'dashboard' || t === 'all-chapters';
}

export interface TabRef {
  entityType: TabEntityType;
  id: string;
}

// Leaf — a single entity occupying a tab slot. The on-screen rendering of
// a leaf is whatever view component matches its entityType.
export interface LeafTab extends TabRef {
  kind: 'leaf';
  isPreview: boolean;
}

// Split — a top-level "fused" tab containing exactly two leaves rendered
// side-by-side. Only the focused side reflects in URL / sidebar / timeline
// selection state; the other side is dormant for those consumers but still
// renders its editor pane.
//
// Splits never nest — `left` and `right` are always LeafTab. This keeps the
// data model and the UX tractable (Chrome-style fused tab, not VS Code's
// recursive editor groups).
export interface SplitTab {
  kind: 'split';
  id: string; // stable id used for the synthetic tab key
  left: LeafTab;
  right: LeafTab;
  focused: 'left' | 'right';
  splitRatio: number; // 0..1, fraction of width given to the left pane
}

export type AnyTab = LeafTab | SplitTab;

// Backwards-compat alias for the pre-split-pane code that imported `Tab`.
// New code should reference `LeafTab` or `AnyTab` directly.
export type Tab = LeafTab;

export interface ProjectTabsState {
  openTabs: AnyTab[];
  activeTabKey: string | null;
}

// Synthetic key used by the tab bar to identify a top-level tab. Leaves
// keep the historical `entityType:id` form so existing keyboard / right-bar
// code that pattern-matches keeps working; splits get a `split:<id>` prefix
// that callers must opt-in to handle.
export function tabKey(tab: AnyTab | TabRef): string {
  if ('kind' in tab && tab.kind === 'split') return `split:${tab.id}`;
  return `${tab.entityType}:${tab.id}`;
}

// The leaf whose entity the focused pane is currently showing. For a leaf
// tab that's itself; for a split tab it's the side under `focused`.
export function focusedLeafOf(tab: AnyTab): LeafTab {
  if (tab.kind === 'leaf') return tab;
  return tab.focused === 'left' ? tab.left : tab.right;
}

function makeLeafTab(ref: TabRef, isPreview: boolean): LeafTab {
  return { kind: 'leaf', entityType: ref.entityType, id: ref.id, isPreview };
}

// Generate a synthetic split id without pulling in a uuid dep.
function generateSplitId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_PROJECT_TABS: ProjectTabsState = Object.freeze({
  openTabs: [] as AnyTab[],
  activeTabKey: null,
}) as ProjectTabsState;

export interface SidebarState {
  isOpen: boolean;
  width: number;
}

type SelectionSource = 'route' | 'ui' | 'system';
export type EditorShellView =
  | 'project-home'
  | 'project-dashboard'
  | 'node-editor'
  | 'storyline-editor'
  | 'element-editor'
  | 'category-editor'
  | 'all-chapters-editor'
  | 'unknown';

interface EntitySelectionState {
  selectedId: string | null;
  selectedFrom: SelectionSource | null;
  selectedAt: number | null;
}

interface NodeUiContextState extends EntitySelectionState {
  activeStorylineId: string | null;
}

interface ElementUiContextState extends EntitySelectionState {
  activeCategoryId: string | null;
}

interface EditorRuntimeState {
  view: EditorShellView;
  activeEntityType: 'node' | 'element' | 'none';
}

interface UiState {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;

  sidebars: Record<SidebarType, SidebarState>;

  toggleSidebar: (type: SidebarType) => void;
  setSidebarOpen: (type: SidebarType, isOpen: boolean) => void;
  setSidebarWidth: (type: SidebarType, width: number) => void;

  nodeUi: NodeUiContextState;
  setNodeSelection: (id: string | null, source?: SelectionSource) => void;
  setNodeActiveStorylineId: (storylineId: string | null) => void;
  clearNodeUiContext: () => void;

  elementUi: ElementUiContextState;
  setElementSelection: (id: string | null, source?: SelectionSource) => void;
  setElementActiveCategoryId: (categoryId: string | null) => void;
  clearElementUiContext: () => void;

  editorRuntime: EditorRuntimeState;
  setEditorRuntime: (runtime: EditorRuntimeState) => void;

  selectedElementId: string | null;
  setSelectedElementId: (id: string | null) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  timelineHeight: number;
  setTimelineHeight: (height: number) => void;

  // Left outline rail (per-editor TOC) collapse state. Shared across all
  // entity editors so the toggle persists when switching between chapter /
  // element / storyline / category tabs.
  outlineCollapsed: boolean;
  setOutlineCollapsed: (collapsed: boolean) => void;
  toggleOutlineCollapsed: () => void;

  // BottomTimeline visibility. The bottom status bar always shows; the
  // timeline is hidden by default off-button-click, restored by the same
  // button. There is no "collapsed" timeline state anymore — it's either
  // present in full or absent entirely.
  bottomTimelineHidden: boolean;
  setBottomTimelineHidden: (hidden: boolean) => void;
  toggleBottomTimelineHidden: () => void;

  resizingSidebar: SidebarType | null;
  setResizingSidebar: (type: SidebarType | null) => void;

  activeLeftPanel: 'nodes' | 'elements' | 'drift';
  setActiveLeftPanel: (panel: 'nodes' | 'elements' | 'drift') => void;
  /**
   * NodesPanel layout — 'global' lists every storyline-anchored node sorted by
   * timeline start; 'storyline' groups nodes under their parent storylines.
   * Lifted to the store so the sub-meta toolbar (LeftSidebarSubHeader) can
   * drive it from outside the panel.
   */
  nodesPanelViewMode: 'global' | 'storyline';
  setNodesPanelViewMode: (mode: 'global' | 'storyline') => void;
  activeRightPanel: 'fragments' | 'stats' | 'shadow';
  setActiveRightPanel: (panel: 'fragments' | 'stats' | 'shadow') => void;

  shadowMode: boolean;
  setShadowMode: (active: boolean) => void;
  toggleShadowMode: () => void;

  activeSuperView: 'none' | 'element' | 'graph' | 'reference';
  setActiveSuperView: (view: 'none' | 'element' | 'graph' | 'reference') => void;
  lastActiveSuperView: 'element' | 'graph' | 'reference' | null;
  setLastActiveSuperView: (view: 'element' | 'graph' | 'reference' | null) => void;

  tabsByProject: Record<string, ProjectTabsState>;
  openEntityTab: (projectId: string, ref: TabRef, options?: { preview?: boolean }) => void;
  promoteTab: (projectId: string, ref?: TabRef) => void;
  // Close a top-level tab (either a leaf or a whole split). Returns:
  //   • nextActive — the leaf that should become active next so the URL /
  //     focused view can be updated. Non-null only when the closed tab WAS
  //     the active one AND a successor exists; null otherwise.
  //   • wasActive — whether the tab being closed was the currently active
  //     one. Callers need this to tell "closed active, no tabs left → go
  //     to blank" apart from "closed a non-active tab → leave URL alone".
  //     Without it both cases collapse to nextActive === null and any
  //     fallback navigation would clobber the URL of whatever IS still
  //     active (or re-create a singleton tab when navigating home).
  closeTab: (
    projectId: string,
    ref: TabRef | { splitId: string },
  ) => { nextActive: LeafTab | null; wasActive: boolean };
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  setActiveTab: (projectId: string, ref: TabRef | { splitId: string } | null) => void;
  clearProjectTabs: (projectId: string) => void;

  // Split-pane actions. All operate on the project's top-level tab list.
  // "Active" below means the tab keyed by activeTabKey.

  // Take `sourceKey` (a leaf already in the bar, OR a fresh TabRef to open)
  // and place it as the `side` half of a split alongside the active tab.
  // Cases:
  //   • Active is a leaf: replace it with a SplitTab where active = the
  //     opposite side, source = `side`. Focus lands on `side`.
  //   • Active is a split: replace `side` of the split with source. Focus
  //     moves to `side`.
  //   • No active tab: degrade to a plain openEntityTab.
  // If source is already present in openTabs as a top-level leaf, that
  // duplicate is removed first.
  splitActiveWith: (
    projectId: string,
    source: TabRef | { fromKey: string },
    side: 'left' | 'right',
  ) => void;

  // Inside a split, change which side is focused (drives URL / sidebar
  // highlight). No-op if the split or side doesn't exist.
  setSplitFocus: (projectId: string, splitId: string, side: 'left' | 'right') => void;

  // Width fraction for the left pane (right is 1 - ratio). Clamped to
  // [0.15, 0.85] to keep both panes usable.
  setSplitRatio: (projectId: string, splitId: string, ratio: number) => void;

  // Swap left ↔ right. Preserves which logical side has focus (i.e. the
  // entity that was focused remains focused; the focused flag flips sides).
  swapSplitPanes: (projectId: string, splitId: string) => void;

  // Pull one side out of a split. The split degrades to a single leaf
  // (the surviving side) in place. The extracted leaf is inserted as a
  // sibling top-level leaf immediately after the split's slot. Returns the
  // leaf that ends up active so the caller can navigate the URL to match.
  extractFromSplit: (
    projectId: string,
    splitId: string,
    side: 'left' | 'right',
  ) => { nextActive: LeafTab | null };

  // Close one side of a split. The split degrades to a single leaf — the
  // other side — sitting in the same position. Returns the surviving leaf
  // for URL sync.
  closeSplitSide: (
    projectId: string,
    splitId: string,
    side: 'left' | 'right',
  ) => { nextActive: LeafTab | null };

  // Dissolve a split: replace it with its two leaves in left, right order
  // at the same position in openTabs. The previously focused side becomes
  // the new active tab. Returns it for URL sync.
  unsplitTab: (projectId: string, splitId: string) => { nextActive: LeafTab | null };

  // Bulk-close ops. Active-tab follows the same "prefer the right neighbor"
  // rule as closeTab. closeOthers / closeToRight are bar-level (top-level
  // tabs), not split-internal.
  closeOtherTabs: (projectId: string, keepKey: string) => { nextActive: LeafTab | null };
  closeTabsToRight: (projectId: string, anchorKey: string) => { nextActive: LeafTab | null };
  closeAllTabs: (projectId: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',

      sidebars: {
        left: {
          isOpen: true,
          width: 280,
        },
        right: {
          isOpen: false,
          width: 300,
        },
      },

      setTheme: (theme) => set({ theme }),

      toggleSidebar: (type) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              isOpen: !state.sidebars[type].isOpen,
            },
          },
        })),

      setSidebarOpen: (type, isOpen) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              isOpen,
            },
          },
        })),

      setSidebarWidth: (type, width) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              width,
            },
          },
        })),

      nodeUi: {
        selectedId: null,
        selectedFrom: null,
        selectedAt: null,
        activeStorylineId: null,
      },
      setNodeSelection: (id, source = 'ui') =>
        set((state) => ({
          selectedNodeId: id,
          nodeUi: {
            ...state.nodeUi,
            selectedId: id,
            selectedFrom: id ? source : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      setNodeActiveStorylineId: (storylineId) =>
        set((state) => ({
          nodeUi: {
            ...state.nodeUi,
            activeStorylineId: storylineId,
          },
        })),
      clearNodeUiContext: () =>
        set((state) => ({
          selectedNodeId: null,
          nodeUi: {
            ...state.nodeUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeStorylineId: null,
          },
        })),

      elementUi: {
        selectedId: null,
        selectedFrom: null,
        selectedAt: null,
        activeCategoryId: null,
      },
      setElementSelection: (id, source = 'ui') =>
        set((state) => ({
          selectedElementId: id,
          elementUi: {
            ...state.elementUi,
            selectedId: id,
            selectedFrom: id ? source : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      setElementActiveCategoryId: (categoryId) =>
        set((state) => ({
          elementUi: {
            ...state.elementUi,
            activeCategoryId: categoryId,
          },
        })),
      clearElementUiContext: () =>
        set((state) => ({
          selectedElementId: null,
          elementUi: {
            ...state.elementUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeCategoryId: null,
          },
        })),

      editorRuntime: {
        view: 'unknown',
        activeEntityType: 'none',
      },
      setEditorRuntime: (runtime) => set({ editorRuntime: runtime }),

      selectedElementId: null,
      setSelectedElementId: (id) =>
        set((state) => ({
          selectedElementId: id,
          elementUi: {
            ...state.elementUi,
            selectedId: id,
            selectedFrom: id ? 'ui' : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      selectedNodeId: null,
      setSelectedNodeId: (id) =>
        set((state) => ({
          selectedNodeId: id,
          nodeUi: {
            ...state.nodeUi,
            selectedId: id,
            selectedFrom: id ? 'ui' : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      timelineHeight: 200,
      setTimelineHeight: (height) => set({ timelineHeight: height }),

      outlineCollapsed: false,
      setOutlineCollapsed: (collapsed) => set({ outlineCollapsed: collapsed }),
      toggleOutlineCollapsed: () =>
        set((state) => ({ outlineCollapsed: !state.outlineCollapsed })),

      bottomTimelineHidden: false,
      setBottomTimelineHidden: (hidden) => set({ bottomTimelineHidden: hidden }),
      toggleBottomTimelineHidden: () =>
        set((state) => ({ bottomTimelineHidden: !state.bottomTimelineHidden })),

      resizingSidebar: null,
      setResizingSidebar: (type) => set({ resizingSidebar: type }),

      activeLeftPanel: 'elements',
      setActiveLeftPanel: (panel) => set({ activeLeftPanel: panel }),
      nodesPanelViewMode: 'storyline',
      setNodesPanelViewMode: (mode) => set({ nodesPanelViewMode: mode }),
      activeRightPanel: 'fragments',
      setActiveRightPanel: (panel) => set({ activeRightPanel: panel }),

      shadowMode: false,
      setShadowMode: (active) =>
        set((state) => {
          // Auto-focus the Shadow tab when entering shadow mode; restore the
          // default tab if the user leaves shadow mode while on Shadow.
          if (active) {
            return { shadowMode: true, activeRightPanel: 'shadow' };
          }
          return {
            shadowMode: false,
            activeRightPanel: state.activeRightPanel === 'shadow' ? 'fragments' : state.activeRightPanel,
          };
        }),
      toggleShadowMode: () =>
        set((state) => {
          const next = !state.shadowMode;
          if (next) return { shadowMode: true, activeRightPanel: 'shadow' };
          return {
            shadowMode: false,
            activeRightPanel: state.activeRightPanel === 'shadow' ? 'fragments' : state.activeRightPanel,
          };
        }),

      activeSuperView: 'none',
      setActiveSuperView: (view) => {
        set(() => {
          const updates: Partial<UiState> = { activeSuperView: view };
          if (view !== 'none') {
            updates.lastActiveSuperView = view;
          }
          return updates;
        });
      },
      lastActiveSuperView: null,
      setLastActiveSuperView: (view) => set({ lastActiveSuperView: view }),

      tabsByProject: {},

      // Open an entity as a tab. Semantics differ based on the active tab:
      //
      //   • Active is a SplitTab → replace the focused side's leaf with the
      //     new ref. The split tab itself stays active; only its focused
      //     side's entity changes. The preview-slot promotion logic doesn't
      //     apply here (splits don't have a preview slot).
      //
      //   • Active is a LeafTab (or no active tab) → preserve the existing
      //     preview-slot behaviour: an open dedicated tab is activated in
      //     place, a preview tab is replaced, otherwise append.
      openEntityTab: (projectId, ref, options) =>
        set((state) => {
          const preview = options?.preview ?? true;
          const project = state.tabsByProject[projectId] ?? EMPTY_PROJECT_TABS;
          const newLeaf = makeLeafTab(ref, preview);
          const key = tabKey(newLeaf);

          // Singletons (dashboard / all-chapters) never silently replace
          // the focused side of a split — clicking the Home / 通览全书
          // button should ALWAYS surface a top-level singleton tab, never
          // hide it inside the current split. The only way for a singleton
          // to live inside a split is an explicit drag-to-split or context-
          // menu "在右侧打开"; both of those go through splitActiveWith,
          // not here.
          //
          // Behavior:
          //   • Singleton already exists at top-level → activate it.
          //   • Singleton already exists inside a split → activate that
          //     split and focus the side holding it.
          //   • Singleton not open → standard preview-replace-or-append
          //     (same as a regular entity entering an empty / leaf-active
          //     context).
          if (isSingletonTabType(ref.entityType)) {
            const topLevelIdx = project.openTabs.findIndex(
              (t) => t.kind === 'leaf' && tabKey(t) === key,
            );
            if (topLevelIdx >= 0) {
              return {
                tabsByProject: {
                  ...state.tabsByProject,
                  [projectId]: { ...project, activeTabKey: key },
                },
              };
            }
            for (let i = 0; i < project.openTabs.length; i++) {
              const t = project.openTabs[i];
              if (t.kind !== 'split') continue;
              const side: 'left' | 'right' | null =
                tabKey(t.left) === key ? 'left' : tabKey(t.right) === key ? 'right' : null;
              if (!side) continue;
              const updated: SplitTab = { ...t, focused: side };
              const nextOpenTabs = project.openTabs.slice();
              nextOpenTabs[i] = updated;
              return {
                tabsByProject: {
                  ...state.tabsByProject,
                  [projectId]: { openTabs: nextOpenTabs, activeTabKey: tabKey(updated) },
                },
              };
            }
            // Fall through to the append-or-replace-preview branch below
            // (skipping the split-replace-focused-side path entirely).
          } else {
            // Non-singleton: when the active tab is a split, opening a
            // new entity replaces the focused side. Chrome-style behavior
            // expected from sidebar clicks while a split is active.
            const activeTab = project.openTabs.find((t) => tabKey(t) === project.activeTabKey);
            if (activeTab && activeTab.kind === 'split') {
              const split = activeTab;
              const focusedKey = tabKey(focusedLeafOf(split));
              if (focusedKey === key) return {};
              const updated: SplitTab = {
                ...split,
                [split.focused]: { ...newLeaf, isPreview: false },
              } as SplitTab;
              const nextOpenTabs = project.openTabs.map((t) =>
                tabKey(t) === project.activeTabKey ? updated : t,
              );
              return {
                tabsByProject: {
                  ...state.tabsByProject,
                  [projectId]: { ...project, openTabs: nextOpenTabs },
                },
              };
            }
          }

          // Active is a leaf (or nothing) → original semantics. Singletons
          // not found anywhere also land here for the append path.
          const existingIdx = project.openTabs.findIndex((t) => tabKey(t) === key);

          let nextOpenTabs: AnyTab[];
          if (existingIdx >= 0) {
            // Already open — just activate. Preserve dedicated/preview state.
            nextOpenTabs = project.openTabs;
          } else if (preview) {
            // Replace existing preview LEAF in place, or append new preview.
            // Splits never have isPreview, so they're naturally skipped.
            const previewIdx = project.openTabs.findIndex(
              (t) => t.kind === 'leaf' && t.isPreview,
            );
            if (previewIdx >= 0) {
              nextOpenTabs = project.openTabs.slice();
              nextOpenTabs[previewIdx] = newLeaf;
            } else {
              nextOpenTabs = [...project.openTabs, newLeaf];
            }
          } else {
            nextOpenTabs = [...project.openTabs, { ...newLeaf, isPreview: false }];
          }

          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: key },
            },
          };
        }),

      promoteTab: (projectId, ref) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const targetKey = ref ? tabKey(ref) : project.activeTabKey;
          if (!targetKey) return {};
          const idx = project.openTabs.findIndex((t) => tabKey(t) === targetKey);
          if (idx < 0) return {};
          const target = project.openTabs[idx];
          if (target.kind !== 'leaf' || !target.isPreview) return {};
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs[idx] = { ...target, isPreview: false };
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      closeTab: (projectId, ref) => {
        let nextActive: LeafTab | null = null;
        let wasActive = false;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const key =
            'splitId' in ref ? `split:${ref.splitId}` : `${ref.entityType}:${ref.id}`;
          const idx = project.openTabs.findIndex((t) => tabKey(t) === key);
          if (idx < 0) return {};
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs.splice(idx, 1);

          let nextActiveTabKey: string | null = project.activeTabKey;
          if (project.activeTabKey === key) {
            wasActive = true;
            if (nextOpenTabs.length === 0) {
              nextActiveTabKey = null;
            } else {
              const successor =
                idx < nextOpenTabs.length ? nextOpenTabs[idx] : nextOpenTabs[nextOpenTabs.length - 1];
              nextActiveTabKey = tabKey(successor);
              nextActive = focusedLeafOf(successor);
            }
          }
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive, wasActive };
      },

      reorderTabs: (projectId, fromIndex, toIndex) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          if (
            fromIndex === toIndex ||
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= project.openTabs.length ||
            toIndex >= project.openTabs.length
          ) {
            return {};
          }
          const nextOpenTabs = project.openTabs.slice();
          const [moved] = nextOpenTabs.splice(fromIndex, 1);
          nextOpenTabs.splice(toIndex, 0, moved);
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      setActiveTab: (projectId, ref) =>
        set((state) => {
          const project = state.tabsByProject[projectId] ?? EMPTY_PROJECT_TABS;
          let nextKey: string | null;
          if (!ref) nextKey = null;
          else if ('splitId' in ref) nextKey = `split:${ref.splitId}`;
          else nextKey = `${ref.entityType}:${ref.id}`;
          if (project.activeTabKey === nextKey) return {};
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, activeTabKey: nextKey },
            },
          };
        }),

      clearProjectTabs: (projectId) =>
        set((state) => {
          if (!state.tabsByProject[projectId]) return {};
          const rest = { ...state.tabsByProject };
          delete rest[projectId];
          return { tabsByProject: rest };
        }),

      splitActiveWith: (projectId, source, side) =>
        set((state) => {
          const project = state.tabsByProject[projectId] ?? EMPTY_PROJECT_TABS;
          if (project.openTabs.length === 0 || project.activeTabKey === null) {
            // Nothing to split against — fall through to a regular open if
            // the source is a fresh TabRef.
            if ('fromKey' in source) return {};
            const newLeaf = makeLeafTab(source, false);
            return {
              tabsByProject: {
                ...state.tabsByProject,
                [projectId]: {
                  openTabs: [newLeaf],
                  activeTabKey: tabKey(newLeaf),
                },
              },
            };
          }

          // Resolve the source leaf and remove it from openTabs if it was
          // already a top-level leaf (we're about to fold it into a split).
          let sourceLeaf: LeafTab | null = null;
          const workingTabs = project.openTabs.slice();
          if ('fromKey' in source) {
            const srcIdx = workingTabs.findIndex((t) => tabKey(t) === source.fromKey);
            if (srcIdx >= 0) {
              const src = workingTabs[srcIdx];
              if (src.kind === 'leaf') {
                sourceLeaf = { ...src, isPreview: false };
                workingTabs.splice(srcIdx, 1);
              }
            }
            if (!sourceLeaf) return {};
          } else {
            sourceLeaf = makeLeafTab(source, false);
            // Strip any existing top-level leaf for the same entity to avoid
            // duplication once it lives inside the split.
            const dupIdx = workingTabs.findIndex(
              (t) => t.kind === 'leaf' && tabKey(t) === tabKey(sourceLeaf!),
            );
            if (dupIdx >= 0) workingTabs.splice(dupIdx, 1);
          }

          const activeIdx = workingTabs.findIndex(
            (t) => tabKey(t) === project.activeTabKey,
          );
          if (activeIdx < 0) {
            // Active tab got removed by the dup-strip above (source was the
            // active leaf). Just open the source as a new leaf.
            const restored = [...workingTabs, sourceLeaf];
            return {
              tabsByProject: {
                ...state.tabsByProject,
                [projectId]: { openTabs: restored, activeTabKey: tabKey(sourceLeaf) },
              },
            };
          }

          const active = workingTabs[activeIdx];
          let newSplit: SplitTab;
          if (active.kind === 'leaf') {
            const activeLeaf: LeafTab = { ...active, isPreview: false };
            const left = side === 'left' ? sourceLeaf : activeLeaf;
            const right = side === 'left' ? activeLeaf : sourceLeaf;
            newSplit = {
              kind: 'split',
              id: generateSplitId(),
              left,
              right,
              focused: side,
              splitRatio: 0.5,
            };
          } else {
            // Active is already a split — replace the requested side with
            // the source leaf and shift focus there.
            newSplit = {
              ...active,
              [side]: { ...sourceLeaf, isPreview: false },
              focused: side,
            } as SplitTab;
          }
          workingTabs[activeIdx] = newSplit;
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: workingTabs, activeTabKey: tabKey(newSplit) },
            },
          };
        }),

      setSplitFocus: (projectId, splitId, side) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const nextOpenTabs = project.openTabs.map((t) => {
            if (t.kind !== 'split' || t.id !== splitId) return t;
            if (t.focused === side) return t;
            return { ...t, focused: side };
          });
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      setSplitRatio: (projectId, splitId, ratio) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const clamped = Math.max(0.15, Math.min(0.85, ratio));
          const nextOpenTabs = project.openTabs.map((t) => {
            if (t.kind !== 'split' || t.id !== splitId) return t;
            if (Math.abs(t.splitRatio - clamped) < 0.001) return t;
            return { ...t, splitRatio: clamped };
          });
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      swapSplitPanes: (projectId, splitId) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const nextOpenTabs = project.openTabs.map((t) => {
            if (t.kind !== 'split' || t.id !== splitId) return t;
            return {
              ...t,
              left: t.right,
              right: t.left,
              focused: t.focused === 'left' ? 'right' : 'left',
            } as SplitTab;
          });
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      extractFromSplit: (projectId, splitId, side) => {
        let nextActive: LeafTab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const idx = project.openTabs.findIndex(
            (t) => t.kind === 'split' && t.id === splitId,
          );
          if (idx < 0) return {};
          const split = project.openTabs[idx] as SplitTab;
          const extracted: LeafTab = { ...split[side], isPreview: false };
          const survivor: LeafTab = { ...split[side === 'left' ? 'right' : 'left'], isPreview: false };
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs.splice(idx, 1, survivor, extracted);
          const wasActive = project.activeTabKey === tabKey(split);
          const nextActiveTabKey = wasActive ? tabKey(survivor) : project.activeTabKey;
          if (wasActive) nextActive = survivor;
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive };
      },

      closeSplitSide: (projectId, splitId, side) => {
        let nextActive: LeafTab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const idx = project.openTabs.findIndex(
            (t) => t.kind === 'split' && t.id === splitId,
          );
          if (idx < 0) return {};
          const split = project.openTabs[idx] as SplitTab;
          const survivor: LeafTab = {
            ...split[side === 'left' ? 'right' : 'left'],
            isPreview: false,
          };
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs[idx] = survivor;
          const wasActive = project.activeTabKey === tabKey(split);
          const nextActiveTabKey = wasActive ? tabKey(survivor) : project.activeTabKey;
          if (wasActive) nextActive = survivor;
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive };
      },

      unsplitTab: (projectId, splitId) => {
        let nextActive: LeafTab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const idx = project.openTabs.findIndex(
            (t) => t.kind === 'split' && t.id === splitId,
          );
          if (idx < 0) return {};
          const split = project.openTabs[idx] as SplitTab;
          const left: LeafTab = { ...split.left, isPreview: false };
          const right: LeafTab = { ...split.right, isPreview: false };
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs.splice(idx, 1, left, right);
          const successor = split.focused === 'left' ? left : right;
          const wasActive = project.activeTabKey === tabKey(split);
          const nextActiveTabKey = wasActive ? tabKey(successor) : project.activeTabKey;
          if (wasActive) nextActive = successor;
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive };
      },

      closeOtherTabs: (projectId, keepKey) => {
        let nextActive: LeafTab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const keep = project.openTabs.find((t) => tabKey(t) === keepKey);
          if (!keep) return {};
          nextActive = focusedLeafOf(keep);
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: [keep], activeTabKey: keepKey },
            },
          };
        });
        return { nextActive };
      },

      closeTabsToRight: (projectId, anchorKey) => {
        let nextActive: LeafTab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const idx = project.openTabs.findIndex((t) => tabKey(t) === anchorKey);
          if (idx < 0) return {};
          const nextOpenTabs = project.openTabs.slice(0, idx + 1);
          let nextActiveTabKey = project.activeTabKey;
          if (
            project.activeTabKey &&
            !nextOpenTabs.some((t) => tabKey(t) === project.activeTabKey)
          ) {
            nextActiveTabKey = anchorKey;
            nextActive = focusedLeafOf(nextOpenTabs[idx]);
          }
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive };
      },

      closeAllTabs: (projectId) =>
        set((state) => {
          if (!state.tabsByProject[projectId]) return {};
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: [], activeTabKey: null },
            },
          };
        }),
    }),
    {
      name: 'ui-storage', // unique name
      version: 2,
      partialize: (state) => ({
        theme: state.theme,
        sidebars: state.sidebars,
        activeLeftPanel: state.activeLeftPanel,
        nodesPanelViewMode: state.nodesPanelViewMode,
        activeRightPanel: state.activeRightPanel,
        activeSuperView: state.activeSuperView,
        lastActiveSuperView: state.lastActiveSuperView,
        shadowMode: state.shadowMode,
        tabsByProject: state.tabsByProject,
        outlineCollapsed: state.outlineCollapsed,
        bottomTimelineHidden: state.bottomTimelineHidden,
      }),
      // v1 → v2 migration adds the `kind` discriminator to every tab so the
      // store can tell leaf tabs from split tabs. v1 only had flat Tab[]
      // entries shaped like { entityType, id, isPreview } — coerce them to
      // LeafTab. Unrecognised shapes are dropped rather than crashing the
      // tab bar.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        if (version >= 2) return persisted;
        const state = persisted as { tabsByProject?: Record<string, unknown> };
        if (!state.tabsByProject) return persisted;
        const migrated: Record<string, ProjectTabsState> = {};
        for (const [projectId, raw] of Object.entries(state.tabsByProject)) {
          if (!raw || typeof raw !== 'object') continue;
          const proj = raw as { openTabs?: unknown[]; activeTabKey?: string | null };
          const openTabs: AnyTab[] = [];
          for (const tab of proj.openTabs ?? []) {
            if (!tab || typeof tab !== 'object') continue;
            const t = tab as Partial<LeafTab> & { kind?: string };
            // Future-proof: if a persisted entry already has `kind`, trust it
            // (e.g. a downgrade-then-upgrade cycle).
            if (t.kind === 'leaf' || t.kind === 'split') {
              openTabs.push(t as AnyTab);
              continue;
            }
            if (typeof t.entityType === 'string' && typeof t.id === 'string') {
              openTabs.push({
                kind: 'leaf',
                entityType: t.entityType as TabEntityType,
                id: t.id,
                isPreview: Boolean(t.isPreview),
              });
            }
          }
          migrated[projectId] = {
            openTabs,
            activeTabKey: proj.activeTabKey ?? null,
          };
        }
        return { ...state, tabsByProject: migrated };
      },
      // Older persisted state used 'references' | 'inspirations' | 'ai' for
      // activeRightPanel. Coerce any unknown value back to the default so the
      // first render after upgrade doesn't crash the right panel.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<UiState>) };
        const allowed = new Set(['fragments', 'stats', 'shadow']);
        if (!allowed.has(merged.activeRightPanel as string)) {
          merged.activeRightPanel = 'fragments';
        }
        return merged;
      },
    },
  ),
);

export function useProjectTabs(projectId: string | undefined | null): ProjectTabsState {
  return useUiStore((s) => (projectId ? s.tabsByProject[projectId] : undefined) ?? EMPTY_PROJECT_TABS);
}

export function usePromoteCurrentTab(projectId: string | undefined | null): () => void {
  return useCallback(() => {
    if (projectId) useUiStore.getState().promoteTab(projectId);
  }, [projectId]);
}
