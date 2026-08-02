import { create } from 'zustand';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book-node';
import { normalizeBookNode } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { ProjectAsset } from '../domain/project-asset';
import type { AssetUploadUiState } from '../domain/asset-upload-job';
import type { LibraryItem } from '../domain/library-item';
import type { Comment, CommentAction } from '../domain/comment';
import type { ShadowJob } from '../domain/shadow-job';
import type { BlockSection } from '../domain/block-section';
import type { BookAct } from '../domain/book-act';
import type { DriftGroup } from '../domain/drift-group';
import type { TimelineMarker } from '../domain/timeline-marker';
import type { EntityKind, StructuralEntityKind } from '../domain/entity-kinds';

// User-curated cross-entity link. Mirrors the `entity_relation` table row.
// Inline mentions are NOT mirrored to the store; they're queried on demand
// by ReferencesPanel from the `inline_mention` table.
export interface EntityRelationLink {
  id: string;
  projectId: string;
  fromKind: EntityKind;
  fromId: string;
  toKind: StructuralEntityKind;
  toId: string;
  /** Free-form relation category (NOT endpoint type). Null = uncategorised. */
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

// Key for the trashed-id set below. Kind-scoped so an element and a node that
// happen to share a uuid don't collide.
export const trashedKey = (kind: EntityKind, id: string): string => `${kind}:${id}`;

export type LibraryItemUploadState = AssetUploadUiState;

interface DataState {
  storylines: Storyline[];
  /** storyline.id → nodeId[] */
  storylineNodeMapping: Record<string, string[]>;
  /** node.id → storylineId[]; reverse of storylineNodeMapping, kept in sync by reducers */
  nodeStorylineMapping: Record<string, string[]>;
  /**
   * node.id → primary storyline.id (or null for chapters without a primary —
   * "未归属" — and for drifts which never have storylines). Single source of
   * truth for "which storyline owns this chapter in lane rendering" after the
   * mainStorylineId column was retired. Kept in sync by reducers; populated
   * from node_storyline_link.is_primary during hydrate.
   */
  primaryStorylineByNode: Record<string, string | null>;
  setStorylines: (storylines: Storyline[]) => void;
  addStoryline: (storyline: Storyline) => void;
  updateStoryline: (id: string, updates: Partial<Storyline>) => void;
  removeStoryline: (id: string) => void;
  setStorylineNodeMapping: (mapping: Record<string, string[]>) => void;
  addNodeToStorylineMapping: (storylineId: string, nodeId: string) => void;
  removeNodeFromStorylineMapping: (storylineId: string, nodeId: string) => void;
  setNodeStorylinesMapping: (nodeId: string, storylineIds: string[]) => void;
  setNodeStorylineState: (
    storylineNodeMapping: Record<string, string[]>,
    primaryStorylineByNode: Record<string, string | null>,
  ) => void;
  setPrimaryStorylineByNode: (mapping: Record<string, string | null>) => void;
  setNodePrimaryStoryline: (nodeId: string, storylineId: string | null) => void;

  bookNodes: BookNode[];
  setBookNodes: (nodes: BookNode[]) => void;
  addBookNode: (node: BookNode) => void;
  updateBookNode: (id: string, updates: Partial<BookNode>) => void;
  removeBookNode: (id: string) => void;

  bookElementCategories: BookElementCategory[];
  setBookElementCategories: (categories: BookElementCategory[]) => void;
  addBookElementCategory: (category: BookElementCategory) => void;
  updateBookElementCategory: (id: string, updates: Partial<BookElementCategory>) => void;
  removeBookElementCategory: (id: string) => void;

  bookElements: BookElement[];
  setBookElements: (elements: BookElement[]) => void;
  addBookElement: (element: BookElement) => void;
  updateBookElement: (id: string, updates: Partial<BookElement>) => void;
  removeBookElement: (id: string) => void;

  projectAssets: ProjectAsset[];
  setProjectAssets: (assets: ProjectAsset[]) => void;
  upsertProjectAsset: (asset: ProjectAsset) => void;
  removeProjectAsset: (id: string) => void;

  /**
   * Soft-deleted (trashed) entity ids, keyed via {@link trashedKey}. Trashed
   * rows are filtered OUT of the live arrays above, so by absence alone the
   * editor can't tell "trashed" (recoverable, dim the mention) from
   * "hard-deleted" (gone, strip the mention). This set supplies that
   * distinction. Populated from the server graph on pull + kept live by the
   * trash/restore usecases. Only element + node are inline-mentionable, but we
   * track every soft-deletable kind for completeness.
   */
  trashedEntityIds: Set<string>;
  setTrashedEntityIds: (ids: Set<string>) => void;
  markTrashed: (kind: EntityKind, id: string) => void;
  unmarkTrashed: (kind: EntityKind, id: string) => void;

  libraryItems: LibraryItem[];
  libraryItemUploadStates: Record<string, LibraryItemUploadState>;
  elementPortraitUploadStates: Record<string, AssetUploadUiState>;
  setLibraryItems: (items: LibraryItem[]) => void;
  addLibraryItem: (item: LibraryItem) => void;
  updateLibraryItem: (id: string, updates: Partial<LibraryItem>) => void;
  removeLibraryItem: (id: string) => void;
  setLibraryItemUploadState: (id: string, state: LibraryItemUploadState) => void;
  clearLibraryItemUploadState: (id: string) => void;
  setElementPortraitUploadState: (id: string, state: AssetUploadUiState) => void;
  clearElementPortraitUploadState: (id: string) => void;
  replaceAssetUploadStates: (
    library: Record<string, LibraryItemUploadState>,
    portraits: Record<string, AssetUploadUiState>,
  ) => void;

  comments: Comment[];
  setComments: (comments: Comment[]) => void;
  addComment: (comment: Comment) => void;
  updateComment: (id: string, updates: Partial<Comment>) => void;
  removeComment: (id: string) => void;

  commentActions: CommentAction[];
  setCommentActions: (actions: CommentAction[]) => void;
  addCommentAction: (action: CommentAction) => void;
  updateCommentAction: (id: string, updates: Partial<CommentAction>) => void;
  removeCommentAction: (id: string) => void;

  // Shadow review jobs (observability records; see lib/shadow/job-recorder).
  shadowJobs: ShadowJob[];
  setShadowJobs: (jobs: ShadowJob[]) => void;
  upsertShadowJob: (job: ShadowJob) => void;
  removeShadowJob: (id: string) => void;

  /**
   * User-curated cross-entity relations (comment → node, library_item → element …).
   * Inline mentions are NOT mirrored here; only relation rows used by the
   * right sidebar relation picker.
   */
  entityRelations: EntityRelationLink[];
  setEntityRelations: (relations: EntityRelationLink[]) => void;
  addEntityRelation: (relation: EntityRelationLink) => void;
  removeEntityRelation: (id: string) => void;

  /**
   * Rolling block-range summaries, produced by Copilot debounce runs and
   * consumed by later runs as recent-context (PR B/C). Mirrored here so
   * prompt builders can grab them cheaply without round-tripping SQLite
   * on every keystroke.
   */
  blockSections: BlockSection[];
  setBlockSections: (sections: BlockSection[]) => void;
  addBlockSection: (section: BlockSection) => void;
  updateBlockSection: (id: string, updates: Partial<BlockSection>) => void;
  removeBlockSection: (id: string) => void;

  /** Acts (幕) — boundary segments of the global reading axis. Unsorted;
   *  consumers derive via domain sortActs/deriveActSegments. */
  bookActs: BookAct[];
  setBookActs: (acts: BookAct[]) => void;
  addBookAct: (act: BookAct) => void;
  updateBookAct: (id: string, updates: Partial<BookAct>) => void;
  removeBookAct: (id: string) => void;

  /** Drift groups (左栏分组) — nested folders for drift nodes. Unsorted;
   *  the DriftPanel derives the tree via domain/drift-group helpers. */
  driftGroups: DriftGroup[];
  setDriftGroups: (groups: DriftGroup[]) => void;
  addDriftGroup: (group: DriftGroup) => void;
  updateDriftGroup: (id: string, updates: Partial<DriftGroup>) => void;
  removeDriftGroup: (id: string) => void;

  /** Narrative-axis time pins (optionally drift-bound). Kept sorted by
   *  narrativeOrder by the setters so consumers can render directly. */
  timelineMarkers: TimelineMarker[];
  setTimelineMarkers: (markers: TimelineMarker[]) => void;
  addTimelineMarker: (marker: TimelineMarker) => void;
  updateTimelineMarker: (id: string, updates: Partial<TimelineMarker>) => void;
  removeTimelineMarker: (id: string) => void;
}

function sortMarkers(markers: TimelineMarker[]): TimelineMarker[] {
  return markers.slice().sort((a, b) => a.narrativeOrder - b.narrativeOrder);
}

function deriveNodeStorylineMapping(forward: Record<string, string[]>): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  Object.entries(forward).forEach(([storylineId, nodeIds]) => {
    nodeIds.forEach((nodeId) => {
      const arr = reverse[nodeId] || [];
      if (!arr.includes(storylineId)) {
        reverse[nodeId] = [...arr, storylineId];
      } else {
        reverse[nodeId] = arr;
      }
    });
  });
  return reverse;
}

export const useDataStore = create<DataState>((set) => ({
  storylines: [],
  storylineNodeMapping: {},
  nodeStorylineMapping: {},
  primaryStorylineByNode: {},
  addStoryline: (storyline) => set((state) => ({ storylines: [...state.storylines, storyline] })),
  setStorylines: (storylines) => set({ storylines }),
  updateStoryline: (id, updates) =>
    set((state) => ({
      storylines: state.storylines.map((storyline) =>
        storyline.id === id ? { ...storyline, ...updates } : storyline,
      ),
    })),
  removeStoryline: (id) =>
    set((state) => {
      const remainingForward = { ...state.storylineNodeMapping };
      delete remainingForward[id];
      return {
        storylines: state.storylines.filter((storyline) => storyline.id !== id),
        storylineNodeMapping: remainingForward,
        nodeStorylineMapping: deriveNodeStorylineMapping(remainingForward),
      };
    }),
  setStorylineNodeMapping: (mapping) =>
    set({
      storylineNodeMapping: mapping,
      nodeStorylineMapping: deriveNodeStorylineMapping(mapping),
    }),
  setNodeStorylineState: (storylineNodeMapping, primaryStorylineByNode) =>
    set({
      storylineNodeMapping,
      nodeStorylineMapping: deriveNodeStorylineMapping(storylineNodeMapping),
      primaryStorylineByNode,
    }),
  addNodeToStorylineMapping: (storylineId, nodeId) =>
    set((state) => {
      const existingForward = state.storylineNodeMapping[storylineId] || [];
      if (existingForward.includes(nodeId)) return state;
      const forward = {
        ...state.storylineNodeMapping,
        [storylineId]: [...existingForward, nodeId],
      };
      const existingReverse = state.nodeStorylineMapping[nodeId] || [];
      const reverse = existingReverse.includes(storylineId)
        ? state.nodeStorylineMapping
        : { ...state.nodeStorylineMapping, [nodeId]: [...existingReverse, storylineId] };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),
  removeNodeFromStorylineMapping: (storylineId, nodeId) =>
    set((state) => {
      const forward = {
        ...state.storylineNodeMapping,
        [storylineId]: (state.storylineNodeMapping[storylineId] || []).filter(
          (id) => id !== nodeId,
        ),
      };
      const reverse = {
        ...state.nodeStorylineMapping,
        [nodeId]: (state.nodeStorylineMapping[nodeId] || []).filter((id) => id !== storylineId),
      };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),
  setPrimaryStorylineByNode: (primaryStorylineByNode) => set({ primaryStorylineByNode }),
  setNodePrimaryStoryline: (nodeId, storylineId) =>
    set((state) => ({
      primaryStorylineByNode: { ...state.primaryStorylineByNode, [nodeId]: storylineId },
    })),

  setNodeStorylinesMapping: (nodeId, storylineIds) =>
    set((state) => {
      const forward = { ...state.storylineNodeMapping };
      // Remove nodeId from all storylines where it shouldn't be
      Object.keys(forward).forEach((slId) => {
        if (!storylineIds.includes(slId)) {
          forward[slId] = forward[slId].filter((id) => id !== nodeId);
        }
      });
      // Add nodeId to all storylines where it should be
      storylineIds.forEach((slId) => {
        const existingNodes = forward[slId] || [];
        if (!existingNodes.includes(nodeId)) {
          forward[slId] = [...existingNodes, nodeId];
        }
      });
      const reverse = {
        ...state.nodeStorylineMapping,
        [nodeId]: [...storylineIds],
      };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),

  bookNodes: [],
  setBookNodes: (bookNodes) => set({ bookNodes }),
  addBookNode: (bookNode) => set((state) => ({ bookNodes: [...state.bookNodes, bookNode] })),
  updateBookNode: (id, updates) =>
    set((state) => ({
      bookNodes: state.bookNodes.map((node) => {
        if (node.id !== id) return node;
        const position = updates.position
          ? { ...node.position, ...updates.position }
          : node.position;
        // A naive `{ ...node, ...updates }` can cross the discriminator
        // boundary (e.g. drift→chapter when mainStorylineId is set). Normalize
        // to coerce the merged record back into the correct union variant.
        return normalizeBookNode({ ...node, ...updates, position });
      }),
    })),
  removeBookNode: (id) =>
    set((state) => ({ bookNodes: state.bookNodes.filter((node) => node.id !== id) })),

  bookElementCategories: [],
  setBookElementCategories: (elementCategories) =>
    set({ bookElementCategories: elementCategories }),
  addBookElementCategory: (category) =>
    set((state) => ({ bookElementCategories: [...state.bookElementCategories, category] })),
  updateBookElementCategory: (id, updates) =>
    set((state) => ({
      bookElementCategories: state.bookElementCategories.map((category) =>
        category.id === id ? { ...category, ...updates } : category,
      ),
    })),
  removeBookElementCategory: (id) =>
    set((state) => ({
      bookElementCategories: state.bookElementCategories.filter((category) => category.id !== id),
    })),

  bookElements: [],
  setBookElements: (bookElements) => set({ bookElements }),
  addBookElement: (element) => set((state) => ({ bookElements: [...state.bookElements, element] })),
  updateBookElement: (id, updates) =>
    set((state) => ({
      bookElements: state.bookElements.map((element) =>
        element.id === id ? { ...element, ...updates } : element,
      ),
    })),
  removeBookElement: (id) =>
    set((state) => ({ bookElements: state.bookElements.filter((element) => element.id !== id) })),

  projectAssets: [],
  setProjectAssets: (projectAssets) => set({ projectAssets }),
  upsertProjectAsset: (asset) =>
    set((state) => {
      const exists = state.projectAssets.some((item) => item.id === asset.id);
      return {
        projectAssets: exists
          ? state.projectAssets.map((item) => (item.id === asset.id ? asset : item))
          : [asset, ...state.projectAssets],
      };
    }),
  removeProjectAsset: (id) =>
    set((state) => ({ projectAssets: state.projectAssets.filter((asset) => asset.id !== id) })),

  trashedEntityIds: new Set<string>(),
  setTrashedEntityIds: (trashedEntityIds) => set({ trashedEntityIds }),
  markTrashed: (kind, id) =>
    set((state) => {
      const key = trashedKey(kind, id);
      if (state.trashedEntityIds.has(key)) return {};
      const next = new Set(state.trashedEntityIds);
      next.add(key);
      return { trashedEntityIds: next };
    }),
  unmarkTrashed: (kind, id) =>
    set((state) => {
      const key = trashedKey(kind, id);
      if (!state.trashedEntityIds.has(key)) return {};
      const next = new Set(state.trashedEntityIds);
      next.delete(key);
      return { trashedEntityIds: next };
    }),

  libraryItems: [],
  libraryItemUploadStates: {},
  elementPortraitUploadStates: {},
  setLibraryItems: (libraryItems) => set({ libraryItems }),
  addLibraryItem: (item) => set((state) => ({ libraryItems: [item, ...state.libraryItems] })),
  updateLibraryItem: (id, updates) =>
    set((state) => ({
      libraryItems: state.libraryItems.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),
  removeLibraryItem: (id) =>
    set((state) => {
      const nextUploadStates = { ...state.libraryItemUploadStates };
      delete nextUploadStates[id];
      return {
        libraryItems: state.libraryItems.filter((m) => m.id !== id),
        libraryItemUploadStates: nextUploadStates,
      };
    }),
  setLibraryItemUploadState: (id, uploadState) =>
    set((state) => ({
      libraryItemUploadStates: { ...state.libraryItemUploadStates, [id]: uploadState },
    })),
  clearLibraryItemUploadState: (id) =>
    set((state) => {
      if (!state.libraryItemUploadStates[id]) return {};
      const nextUploadStates = { ...state.libraryItemUploadStates };
      delete nextUploadStates[id];
      return { libraryItemUploadStates: nextUploadStates };
    }),
  setElementPortraitUploadState: (id, uploadState) =>
    set((state) => ({
      elementPortraitUploadStates: {
        ...state.elementPortraitUploadStates,
        [id]: uploadState,
      },
    })),
  clearElementPortraitUploadState: (id) =>
    set((state) => {
      if (!state.elementPortraitUploadStates[id]) return {};
      const nextUploadStates = { ...state.elementPortraitUploadStates };
      delete nextUploadStates[id];
      return { elementPortraitUploadStates: nextUploadStates };
    }),
  replaceAssetUploadStates: (libraryItemUploadStates, elementPortraitUploadStates) =>
    set({ libraryItemUploadStates, elementPortraitUploadStates }),

  comments: [],
  setComments: (comments) => set({ comments }),
  addComment: (comment) => set((state) => ({ comments: [...state.comments, comment] })),
  updateComment: (id, updates) =>
    set((state) => ({
      comments: state.comments.map((comment) =>
        comment.id === id ? { ...comment, ...updates } : comment,
      ),
    })),
  removeComment: (id) =>
    set((state) => ({
      comments: state.comments.filter((comment) => comment.id !== id),
      commentActions: state.commentActions.filter((action) => action.commentId !== id),
    })),

  commentActions: [],
  setCommentActions: (commentActions) => set({ commentActions }),
  addCommentAction: (action) =>
    set((state) => ({ commentActions: [...state.commentActions, action] })),
  updateCommentAction: (id, updates) =>
    set((state) => ({
      commentActions: state.commentActions.map((action) =>
        action.id === id ? { ...action, ...updates } : action,
      ),
    })),
  removeCommentAction: (id) =>
    set((state) => ({
      commentActions: state.commentActions.filter((action) => action.id !== id),
    })),

  shadowJobs: [],
  setShadowJobs: (shadowJobs) => set({ shadowJobs }),
  upsertShadowJob: (job) =>
    set((state) => {
      const i = state.shadowJobs.findIndex((j) => j.id === job.id);
      if (i === -1) return { shadowJobs: [job, ...state.shadowJobs] };
      const next = state.shadowJobs.slice();
      next[i] = job;
      return { shadowJobs: next };
    }),
  removeShadowJob: (id) =>
    set((state) => ({ shadowJobs: state.shadowJobs.filter((j) => j.id !== id) })),

  entityRelations: [],
  setEntityRelations: (entityRelations) => set({ entityRelations }),
  addEntityRelation: (relation) =>
    set((state) => ({ entityRelations: [...state.entityRelations, relation] })),
  removeEntityRelation: (id) =>
    set((state) => ({
      entityRelations: state.entityRelations.filter((r) => r.id !== id),
    })),

  blockSections: [],
  setBlockSections: (blockSections) => set({ blockSections }),
  addBlockSection: (section) =>
    set((state) => ({ blockSections: [...state.blockSections, section] })),
  updateBlockSection: (id, updates) =>
    set((state) => ({
      blockSections: state.blockSections.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    })),
  removeBlockSection: (id) =>
    set((state) => ({
      blockSections: state.blockSections.filter((s) => s.id !== id),
    })),

  bookActs: [],
  setBookActs: (bookActs) => set({ bookActs }),
  addBookAct: (act) => set((state) => ({ bookActs: [...state.bookActs, act] })),
  updateBookAct: (id, updates) =>
    set((state) => ({
      bookActs: state.bookActs.map((act) => (act.id === id ? { ...act, ...updates } : act)),
    })),
  removeBookAct: (id) =>
    set((state) => ({ bookActs: state.bookActs.filter((act) => act.id !== id) })),

  driftGroups: [],
  setDriftGroups: (driftGroups) => set({ driftGroups }),
  addDriftGroup: (group) => set((state) => ({ driftGroups: [...state.driftGroups, group] })),
  updateDriftGroup: (id, updates) =>
    set((state) => ({
      driftGroups: state.driftGroups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
    })),
  removeDriftGroup: (id) =>
    set((state) => ({ driftGroups: state.driftGroups.filter((g) => g.id !== id) })),

  timelineMarkers: [],
  setTimelineMarkers: (timelineMarkers) => set({ timelineMarkers: sortMarkers(timelineMarkers) }),
  addTimelineMarker: (marker) =>
    set((state) => ({ timelineMarkers: sortMarkers([...state.timelineMarkers, marker]) })),
  updateTimelineMarker: (id, updates) =>
    set((state) => ({
      timelineMarkers: sortMarkers(
        state.timelineMarkers.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      ),
    })),
  removeTimelineMarker: (id) =>
    set((state) => ({
      timelineMarkers: state.timelineMarkers.filter((m) => m.id !== id),
    })),
}));
