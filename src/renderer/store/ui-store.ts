import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarType = 'left' | 'right';

// Sort modes for the three left panels. The SortMenu in the sub-header
// drives these — each panel reads its own value and applies it inside its
// useMemo'd sort step. Direction is baked into each mode (createdAt /
// updatedAt → desc; title / alphabet → asc; bookOrder / narrativeOrder → asc).
export type DriftSortMode = 'createdAt' | 'updatedAt' | 'title';
export type ChapterGlobalSortMode = 'bookOrder' | 'narrativeOrder' | 'createdAt' | 'updatedAt';
export type ChapterStorylineInnerSortMode = 'bookOrder' | 'narrativeOrder';
export type ElementSortMode = 'alphabet' | 'createdAt';

// What the right edge of a node cell (章节 / 浮缀) shows. The 章节 and 浮缀
// panels each keep their own preference (toggled from their respective
// SortMenu); this is just the shared value type.
export type NodeCellMeta = 'date' | 'wordCount' | 'both' | 'none';

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

  // BottomTimeline visibility. The bottom status bar always shows; the
  // timeline is hidden by default off-button-click, restored by the same
  // button. There is no "collapsed" timeline state anymore — it's either
  // present in full or absent entirely.
  bottomTimelineHidden: boolean;
  setBottomTimelineHidden: (hidden: boolean) => void;
  toggleBottomTimelineHidden: () => void;

  // In-chapter plot planner dock (mini-Excel grid). Global visibility flag
  // like the outline toggle — each node editor renders its OWN node's grid.
  // Height is shared across nodes; null = default. Both persisted so the
  // layout sticks across sessions.
  plotPlannerOpen: boolean;
  setPlotPlannerOpen: (open: boolean) => void;
  togglePlotPlannerOpen: () => void;
  plotPlannerHeight: number | null;
  setPlotPlannerHeight: (height: number | null) => void;

  // Resized height of the ElementPanel category footer. null = natural
  // one-row height (horizontal scroll mode).
  elementCategoryFooterHeight: number | null;
  setElementCategoryFooterHeight: (height: number | null) => void;

  // Resized height of the ChapterPanel 未归属 footer when expanded. null =
  // default ratio (40% of the panel). Persisted so the layout sticks across
  // sessions; only meaningful while the footer is expanded.
  chapterUnaffiliatedFooterHeight: number | null;
  setChapterUnaffiliatedFooterHeight: (height: number | null) => void;

  // Whether the BottomTimeline 未归属 lane is currently visible. Persisted so
  // toggling the lane sticks across sessions; the lane itself is meaningful
  // only when the project has at least one storyline (see BottomTimeline).
  bottomTimelineUnaffiliatedVisible: boolean;
  setBottomTimelineUnaffiliatedVisible: (visible: boolean) => void;

  resizingSidebar: SidebarType | null;
  setResizingSidebar: (type: SidebarType | null) => void;

  activeLeftPanel: 'nodes' | 'elements' | 'drift';
  setActiveLeftPanel: (panel: 'nodes' | 'elements' | 'drift') => void;
  // Global Edit Chapter Storyline modal target — set to a chapter id to open
  // the modal, null to close. Lives in the store (instead of local state in
  // every caller) so the chapter context menus in BottomTimeline and
  // StoryGraphView can open it without each owning a copy of the dialog.
  chapterStorylineEditorNodeId: string | null;
  setChapterStorylineEditorNodeId: (nodeId: string | null) => void;

  // Pending entity action queue. Left-sidebar context menus dispatch actions
  // that need editor-local modals (e.g. element 'categoryPicker', drift
  // conversions) by opening the entity tab AND queueing the action here. The
  // target editor view consumes the queued action on mount / when the matching
  // entity becomes active.
  pendingEntityAction: { entityType: TabEntityType; id: string; action: string } | null;
  enqueueEntityAction: (entityType: TabEntityType, id: string, action: string) => void;
  // Pull-and-clear if the queued action matches (entityType, id); otherwise
  // returns null and leaves the queue alone.
  consumeEntityAction: (entityType: TabEntityType, id: string) => string | null;
  /**
   * ChapterPanel layout — 'global' lists every chapter sorted by bookOrder;
   * 'storyline' groups chapters under their primary storylines. Lifted to the
   * store so the sub-meta toolbar (LeftSidebarSubHeader) can drive it from
   * outside the panel.
   */
  chapterPanelViewMode: 'global' | 'storyline';
  setChapterPanelViewMode: (mode: 'global' | 'storyline') => void;

  // Left-panel sort modes — selected from the SortMenu attached to the
  // sub-header. Each panel has its own preference; ChapterPanel splits global
  // vs. storyline-inner since the available modes differ between layouts.
  driftSortMode: DriftSortMode;
  setDriftSortMode: (mode: DriftSortMode) => void;
  chapterGlobalSortMode: ChapterGlobalSortMode;
  setChapterGlobalSortMode: (mode: ChapterGlobalSortMode) => void;
  chapterStorylineInnerSortMode: ChapterStorylineInnerSortMode;
  setChapterStorylineInnerSortMode: (mode: ChapterStorylineInnerSortMode) => void;
  elementSortMode: ElementSortMode;
  setElementSortMode: (mode: ElementSortMode) => void;

  // Right-edge meta shown on node cells (date vs. word count). The 章节 and 浮缀
  // panels keep independent preferences, each toggled from its own SortMenu.
  chapterCellMeta: NodeCellMeta;
  setChapterCellMeta: (mode: NodeCellMeta) => void;
  driftCellMeta: NodeCellMeta;
  setDriftCellMeta: (mode: NodeCellMeta) => void;

  // Storyline-grouped chapter view: a chapter belongs to every storyline it's
  // linked to, so by default it appears in each of those groups. When true it
  // shows only in its primary storyline's group (no cross-group duplicates).
  chapterStorylinePrimaryOnly: boolean;
  setChapterStorylinePrimaryOnly: (only: boolean) => void;

  // The right sidebar splits its tabs into two groups, toggled by a switch at
  // the right end of the tab row. Each group remembers its own active tab.
  rightPanelGroup: 'content' | 'agent';
  setRightPanelGroup: (group: 'content' | 'agent') => void;
  // Content group.
  activeRightPanel: 'todo' | 'library' | 'stats';
  setActiveRightPanel: (panel: 'todo' | 'library' | 'stats') => void;
  // Agent group. 'shadow' only appears when shadowMode is on.
  activeAgentPanel: 'companion' | 'shadow';
  setActiveAgentPanel: (panel: 'companion' | 'shadow') => void;

  // When the right sidebar is wide enough to show both groups side by side,
  // this is the width fraction given to the content (left) column; the agent
  // (right) column gets the remainder. Dragged via the divider between the two
  // columns. Clamped to [0.2, 0.8] so neither column collapses. Persisted
  // globally (the dual-column layout itself isn't per-project).
  rightPanelSplitRatio: number;
  setRightPanelSplitRatio: (ratio: number) => void;

  shadowMode: boolean;
  setShadowMode: (active: boolean) => void;
  toggleShadowMode: () => void;

  activeSuperView: 'none' | 'element' | 'graph' | 'memo-material';
  setActiveSuperView: (view: 'none' | 'element' | 'graph' | 'memo-material') => void;
  lastActiveSuperView: 'element' | 'graph' | 'memo-material' | null;
  setLastActiveSuperView: (view: 'element' | 'graph' | 'memo-material' | null) => void;

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

  // Drop every tab — top-level leaf or split-internal side — that points at
  // the given entity. Splits where both sides match collapse entirely; with
  // only one side matching, the split degrades to the surviving side. Used
  // by delete-entity flows so the tab bar doesn't keep a phantom leaf
  // showing "Untitled" for the now-missing entity.
  closeTabsForEntity: (
    projectId: string,
    ref: TabRef,
  ) => { nextActive: LeafTab | null; wasActive: boolean };
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',

      sidebars: {
        left: {
          isOpen: false,
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

      bottomTimelineHidden: false,
      setBottomTimelineHidden: (hidden) => set({ bottomTimelineHidden: hidden }),

      elementCategoryFooterHeight: null,
      setElementCategoryFooterHeight: (height) => set({ elementCategoryFooterHeight: height }),
      chapterUnaffiliatedFooterHeight: null,
      setChapterUnaffiliatedFooterHeight: (height) =>
        set({ chapterUnaffiliatedFooterHeight: height }),
      bottomTimelineUnaffiliatedVisible: false,
      setBottomTimelineUnaffiliatedVisible: (visible) =>
        set({ bottomTimelineUnaffiliatedVisible: visible }),
      toggleBottomTimelineHidden: () =>
        set((state) => ({ bottomTimelineHidden: !state.bottomTimelineHidden })),

      plotPlannerOpen: false,
      setPlotPlannerOpen: (open) => set({ plotPlannerOpen: open }),
      togglePlotPlannerOpen: () => set((state) => ({ plotPlannerOpen: !state.plotPlannerOpen })),
      plotPlannerHeight: null,
      setPlotPlannerHeight: (height) => set({ plotPlannerHeight: height }),

      resizingSidebar: null,
      setResizingSidebar: (type) => set({ resizingSidebar: type }),

      activeLeftPanel: 'elements',
      setActiveLeftPanel: (panel) => set({ activeLeftPanel: panel }),
      chapterStorylineEditorNodeId: null,
      setChapterStorylineEditorNodeId: (nodeId) => set({ chapterStorylineEditorNodeId: nodeId }),
      pendingEntityAction: null,
      enqueueEntityAction: (entityType, id, action) =>
        set({ pendingEntityAction: { entityType, id, action } }),
      consumeEntityAction: (entityType, id) => {
        const pending = get().pendingEntityAction;
        if (!pending || pending.entityType !== entityType || pending.id !== id) {
          return null;
        }
        set({ pendingEntityAction: null });
        return pending.action;
      },
      chapterPanelViewMode: 'storyline',
      setChapterPanelViewMode: (mode) => set({ chapterPanelViewMode: mode }),

      driftSortMode: 'createdAt',
      setDriftSortMode: (mode) => set({ driftSortMode: mode }),
      chapterGlobalSortMode: 'bookOrder',
      setChapterGlobalSortMode: (mode) => set({ chapterGlobalSortMode: mode }),
      chapterStorylineInnerSortMode: 'bookOrder',
      setChapterStorylineInnerSortMode: (mode) => set({ chapterStorylineInnerSortMode: mode }),
      elementSortMode: 'alphabet',
      setElementSortMode: (mode) => set({ elementSortMode: mode }),

      chapterCellMeta: 'date',
      setChapterCellMeta: (mode) => set({ chapterCellMeta: mode }),
      driftCellMeta: 'date',
      setDriftCellMeta: (mode) => set({ driftCellMeta: mode }),
      chapterStorylinePrimaryOnly: false,
      setChapterStorylinePrimaryOnly: (only) => set({ chapterStorylinePrimaryOnly: only }),
      rightPanelGroup: 'content',
      setRightPanelGroup: (group) => set({ rightPanelGroup: group }),
      // Selecting a tab also marks its group current — so in flat mode (all
      // tabs in one row) the single active tab is well-defined, and collapsing
      // back to the switch lands on the group you last touched.
      activeRightPanel: 'library',
      setActiveRightPanel: (panel) => set({ activeRightPanel: panel, rightPanelGroup: 'content' }),
      activeAgentPanel: 'companion',
      setActiveAgentPanel: (panel) => set({ activeAgentPanel: panel, rightPanelGroup: 'agent' }),

      rightPanelSplitRatio: 0.5,
      setRightPanelSplitRatio: (ratio) =>
        set({ rightPanelSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),

      shadowMode: false,
      setShadowMode: (active) =>
        set((state) => {
          // Entering shadow jumps to the agent group + Shadow tab. Leaving it
          // falls back to Companion (stay in the agent group).
          if (active) {
            return { shadowMode: true, rightPanelGroup: 'agent', activeAgentPanel: 'shadow' };
          }
          return {
            shadowMode: false,
            activeAgentPanel:
              state.activeAgentPanel === 'shadow' ? 'companion' : state.activeAgentPanel,
          };
        }),
      toggleShadowMode: () =>
        set((state) => {
          const next = !state.shadowMode;
          if (next) {
            return { shadowMode: true, rightPanelGroup: 'agent', activeAgentPanel: 'shadow' };
          }
          return {
            shadowMode: false,
            activeAgentPanel:
              state.activeAgentPanel === 'shadow' ? 'companion' : state.activeAgentPanel,
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
            const previewIdx = project.openTabs.findIndex((t) => t.kind === 'leaf' && t.isPreview);
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
          const key = 'splitId' in ref ? `split:${ref.splitId}` : `${ref.entityType}:${ref.id}`;
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
                idx < nextOpenTabs.length
                  ? nextOpenTabs[idx]
                  : nextOpenTabs[nextOpenTabs.length - 1];
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

          const activeIdx = workingTabs.findIndex((t) => tabKey(t) === project.activeTabKey);
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
          let displacedLeaf: LeafTab | null = null;
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
            // the source leaf, and push the leaf that *was* there back into
            // the bar as a top-level tab so the user doesn't silently lose
            // it (same semantics as "extract this side first, then split").
            const existing = side === 'left' ? active.left : active.right;
            if (tabKey(existing) === tabKey(sourceLeaf)) {
              // No-op: source is already the leaf on this side. Avoid
              // duplicating it as a top-level tab.
              return {};
            }
            displacedLeaf = { ...existing, isPreview: false };
            newSplit = {
              ...active,
              [side]: { ...sourceLeaf, isPreview: false },
              focused: side,
            } as SplitTab;
          }
          workingTabs[activeIdx] = newSplit;
          if (displacedLeaf) {
            workingTabs.splice(activeIdx + 1, 0, displacedLeaf);
          }
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
          const idx = project.openTabs.findIndex((t) => t.kind === 'split' && t.id === splitId);
          if (idx < 0) return {};
          const split = project.openTabs[idx] as SplitTab;
          const extracted: LeafTab = { ...split[side], isPreview: false };
          const survivor: LeafTab = {
            ...split[side === 'left' ? 'right' : 'left'],
            isPreview: false,
          };
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
          const idx = project.openTabs.findIndex((t) => t.kind === 'split' && t.id === splitId);
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
          const idx = project.openTabs.findIndex((t) => t.kind === 'split' && t.id === splitId);
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

      closeTabsForEntity: (projectId, ref) => {
        let nextActive: LeafTab | null = null;
        let wasActive = false;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const target = `${ref.entityType}:${ref.id}`;
          const matchesLeaf = (leaf: LeafTab) =>
            leaf.entityType === ref.entityType && leaf.id === ref.id;
          // Map each existing top-level tab to: null (drop), the same tab
          // (keep as-is), or a degraded replacement (split collapsed to its
          // surviving side). The pre/post arrays let us recompute the
          // active-tab key with the same "prefer right neighbor" rule
          // closeTab uses.
          const replacements: Array<AnyTab | null> = project.openTabs.map((tab) => {
            if (tab.kind === 'leaf') {
              return matchesLeaf(tab) ? null : tab;
            }
            const leftDead = matchesLeaf(tab.left);
            const rightDead = matchesLeaf(tab.right);
            if (leftDead && rightDead) return null;
            if (!leftDead && !rightDead) return tab;
            const survivor: LeafTab = leftDead ? tab.right : tab.left;
            return { ...survivor, isPreview: false };
          });
          const nothingChanged = replacements.every((t, i) => t === project.openTabs[i]);
          if (nothingChanged) return {};

          const nextOpenTabs: AnyTab[] = [];
          replacements.forEach((t) => {
            if (t) nextOpenTabs.push(t);
          });

          let nextActiveTabKey: string | null = project.activeTabKey;
          const activeIdx = project.openTabs.findIndex((t) => tabKey(t) === project.activeTabKey);
          const activeStillThere =
            activeIdx >= 0 && replacements[activeIdx] === project.openTabs[activeIdx];
          if (!activeStillThere && project.activeTabKey != null) {
            // Active tab changed identity (split collapsed) or was dropped.
            // Walk right from its original slot for a successor; fall back
            // to the last surviving tab on the bar.
            wasActive = true;
            if (nextOpenTabs.length === 0) {
              nextActiveTabKey = null;
            } else if (activeIdx >= 0) {
              const replacement = replacements[activeIdx];
              if (replacement) {
                nextActiveTabKey = tabKey(replacement);
                nextActive = focusedLeafOf(replacement);
              } else {
                let pick: AnyTab | null = null;
                for (let i = activeIdx + 1; i < replacements.length; i++) {
                  if (replacements[i]) {
                    pick = replacements[i];
                    break;
                  }
                }
                if (!pick) {
                  for (let i = activeIdx - 1; i >= 0; i--) {
                    if (replacements[i]) {
                      pick = replacements[i];
                      break;
                    }
                  }
                }
                if (pick) {
                  nextActiveTabKey = tabKey(pick);
                  nextActive = focusedLeafOf(pick);
                } else {
                  nextActiveTabKey = null;
                }
              }
            } else {
              // activeTabKey pointed at a tab that's already gone — shouldn't
              // happen, but treat as "no successor".
              nextActiveTabKey = null;
            }
          } else if (project.activeTabKey === target) {
            // Defensive: in case target tab equaled the activeTabKey but the
            // identity-stability check above missed it for any reason.
            wasActive = true;
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
    }),
    {
      name: 'ui-storage', // unique name
      version: 2,
      partialize: (state) => ({
        theme: state.theme,
        sidebars: state.sidebars,
        activeLeftPanel: state.activeLeftPanel,
        chapterPanelViewMode: state.chapterPanelViewMode,
        rightPanelGroup: state.rightPanelGroup,
        activeRightPanel: state.activeRightPanel,
        activeAgentPanel: state.activeAgentPanel,
        rightPanelSplitRatio: state.rightPanelSplitRatio,
        activeSuperView: state.activeSuperView,
        lastActiveSuperView: state.lastActiveSuperView,
        shadowMode: state.shadowMode,
        tabsByProject: state.tabsByProject,
        bottomTimelineHidden: state.bottomTimelineHidden,
        plotPlannerOpen: state.plotPlannerOpen,
        plotPlannerHeight: state.plotPlannerHeight,
        elementCategoryFooterHeight: state.elementCategoryFooterHeight,
        chapterUnaffiliatedFooterHeight: state.chapterUnaffiliatedFooterHeight,
        bottomTimelineUnaffiliatedVisible: state.bottomTimelineUnaffiliatedVisible,
        driftSortMode: state.driftSortMode,
        chapterGlobalSortMode: state.chapterGlobalSortMode,
        chapterStorylineInnerSortMode: state.chapterStorylineInnerSortMode,
        elementSortMode: state.elementSortMode,
        chapterCellMeta: state.chapterCellMeta,
        driftCellMeta: state.driftCellMeta,
        chapterStorylinePrimaryOnly: state.chapterStorylinePrimaryOnly,
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
      // Older persisted state used 'references' | 'inspirations' | 'ai' and
      // later 'fragments' for activeRightPanel. After the TODO/Library split
      // the 'fragments' bucket maps to 'library' (素材库 is the dominant
      // surface; TODO is reachable via a sibling tab). Coerce any other
      // unknown value back to the default. Same idea for activeSuperView,
      // which was renamed 'reference' → 'memo-material' when the placeholder
      // view was clarified.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<UiState>) };
        // 'shadow' used to be a right-panel tab; it now lives in the agent
        // group. Migrate an old 'shadow' selection into the new model.
        if ((merged.activeRightPanel as string) === 'shadow') {
          merged.activeRightPanel = 'library';
          merged.activeAgentPanel = 'shadow';
          merged.rightPanelGroup = 'agent';
        }
        if ((merged.activeRightPanel as string) === 'fragments') {
          merged.activeRightPanel = 'library';
        }
        const allowed = new Set(['todo', 'library', 'stats']);
        if (!allowed.has(merged.activeRightPanel as string)) {
          merged.activeRightPanel = 'library';
        }
        const allowedAgent = new Set(['companion', 'shadow']);
        if (!allowedAgent.has(merged.activeAgentPanel as string)) {
          merged.activeAgentPanel = 'companion';
        }
        if (merged.rightPanelGroup !== 'agent' && merged.rightPanelGroup !== 'content') {
          merged.rightPanelGroup = 'content';
        }
        const allowedSuper = new Set(['none', 'element', 'graph', 'memo-material']);
        if ((merged.activeSuperView as string) === 'reference') {
          merged.activeSuperView = 'memo-material';
        } else if (!allowedSuper.has(merged.activeSuperView as string)) {
          merged.activeSuperView = 'none';
        }
        if ((merged.lastActiveSuperView as string) === 'reference') {
          merged.lastActiveSuperView = 'memo-material';
        } else if (
          merged.lastActiveSuperView !== null &&
          !allowedSuper.has(merged.lastActiveSuperView as string)
        ) {
          merged.lastActiveSuperView = null;
        }
        return merged;
      },
    },
  ),
);

export function useProjectTabs(projectId: string | undefined | null): ProjectTabsState {
  return useUiStore(
    (s) => (projectId ? s.tabsByProject[projectId] : undefined) ?? EMPTY_PROJECT_TABS,
  );
}

export function usePromoteCurrentTab(projectId: string | undefined | null): () => void {
  return useCallback(() => {
    if (projectId) useUiStore.getState().promoteTab(projectId);
  }, [projectId]);
}

// Grace period for edit-triggered promotion. Yjs sync, doc rehydration, and
// other implicit Tiptap onUpdate fires happen right after mount and would
// otherwise silently promote a preview tab. The gate returns false while
// inside the grace window so callers can swallow those phantom edits.
// resetKey should be the entity id the editor is bound to — when it changes
// (switch chapter / re-mount on tab switch-back) the timer restarts.
export function useCanPromoteOnEdit(
  resetKey: string | null | undefined,
  graceMs = 3000,
): () => boolean {
  const [initialOpenedAt] = useState(() => Date.now());
  const openedAtRef = useRef<number>(initialOpenedAt);
  useEffect(() => {
    openedAtRef.current = Date.now();
  }, [resetKey]);
  return useCallback(() => Date.now() - openedAtRef.current >= graceMs, [graceMs]);
}
