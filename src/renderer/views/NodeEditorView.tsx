import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import {
  CHAPTER_WRITING_STATUSES,
  CHAPTER_ORDER_STRIDE,
  DRIFT_STATUSES,
  canonicalWordCount,
  isChapter,
  isDrift,
  type WritingStatus,
} from '../domain/book-node';
import type { Storyline } from '../domain/storyline';
import { ChapterEditor, type ChapterEditorRef } from '../components/editor/ChapterEditor';
import { EditorDocumentLoadError } from '../components/editor/EditorDocumentLoadError';
import { LoadingStatus } from '../components/ui/LoadingStatus';
import { DesktopStickyNoteRail as StickyNoteRail } from '../features/comments/desktop/DesktopStickyNoteRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import { useEditorSurfaceLifecycle } from '../components/editor/editor-surface-lifecycle-context';
import { PlotPlannerDock } from '../components/editor/PlotPlannerDock';
import { usePlotPlannerSlot } from '../components/editor/plot-grid/plot-planner-slot';
import type { PlotGridMutation } from '../domain/plot-grid';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings } from '../components/editor/outline-rail-model';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useAgentChangeMarks } from '../hooks/useAgentChangeMarks';
import { unbindMarkersForDrift } from '../hooks/useTimelineMarkers';
import { unbindActsForDrift } from '../usecase/useBookAct';
import type { OutlineItem } from '../lib/outline';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import { openEntityLinkTarget } from '../features/editor/open-entity-link';
import {
  CONVERT_DRIFT_TO_CHAPTER_ACTION,
  CONVERT_DRIFT_TO_ELEMENT_ACTION,
  DRIFT_MOVE_TO_GROUP_ACTION,
  EditorTopBar,
  SET_STATUS_ACTION_PREFIX,
} from '../components/editor/EditorTopBar';
import { useDriftGroup } from '../usecase/useDriftGroup';
import { ROOT_GROUP_KEY, buildDriftGroupChildren } from '../domain/drift-group';
import { useBookElement } from '../usecase/useBookElement';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { requestConfirmation } from '../store/confirmation-store';
import { useSettingsStore } from '../store/settings-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useChapterInsert } from '../features/editor/useChapterInsert';
import { ChapterEndOrnament } from '../components/editor/ChapterEndOrnament';
import { ChapterEndActions } from '../features/editor/ChapterEndActions';
import { getPlatformRuntime } from '../platform/runtime';
import { Button } from '../components/ui/Button';
import { BrushIcon } from '../components/ui/BrushIcon';
import { KindMark } from '../components/ui/KindMark';
import {
  ModalActions,
  ModalBody,
  ModalCard,
  ModalHeader,
  ModalRoot,
} from '../components/ui/Modal';
import { useCanPromoteOnEdit, usePromoteCurrentTab, useUiStore } from '../store/ui-store';
import { editorTabSelectionKey } from '../lib/editor-selection-memory';
import type { EditorCommentRequest } from '../hooks/useEntityEditor';
import { useEntityStickyNoteRail } from '../hooks/useEntityStickyNoteRail';
import { getLiveYDoc } from '../lib/yjs-doc-registry';
import { makeDocId } from '../lib/yjs-doc-id';

const log = loglevel.getLogger('NodeEditorView');
log.setLevel(loglevel.levels.ERROR);
// log.setLevel(loglevel.levels.DEBUG);

// In split-pane mode this view is mounted directly (not via Outlet), so the
// URL won't always reflect the side this instance is rendering. Pass the leaf
// id explicitly via `nodeIdOverride` and we'll use that instead of useParams.
export function NodeEditorView({ nodeIdOverride }: { nodeIdOverride?: string } = {}) {
  const params = useParams<{ nodeId: string; projectId: string }>();
  const nodeId = nodeIdOverride ?? params.nodeId;
  if (!nodeId) return <Navigate to="/" replace />;
  return <NodeEditorSession nodeId={nodeId} projectId={params.projectId} />;
}

// Routing changes every tab switch. The retained editor session only receives
// its stable owner IDs; unrelated routes must not rebuild all hidden editors.
const NodeEditorSession = memo(function NodeEditorSession({ nodeId, projectId }: { nodeId: string; projectId?: string }) {
  const { t } = useTranslation();
  const { navigateToElement, leaveDeletedEntity, openEntity } = useProjectNavigation();
  const { isCommandActive, isVisible, reportReady } = useEditorSurfaceLifecycle();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) {
    throw new Error('NodeEditorView requires a projectId');
  }
  if (!userId) {
    throw new Error('NodeEditorView requires a logged-in user');
  }
  const activeProjectId = projectId;
  const activeUserId = userId;
  const promoteCurrentTab = usePromoteCurrentTab(activeProjectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(nodeId);
  const {
    storylines,
    nodeStorylineMapping,
    bookElementCategories,
    primaryStorylineByNode,
  } = useDataStoreFields(
    'storylines',
    'nodeStorylineMapping',
    'bookElementCategories',
    'primaryStorylineByNode',
  );
  const driftGroups = useDataStore((s) => s.driftGroups);
  // Keep the loaded seed keyed to its owner. During A -> B navigation the
  // previous row must never be passed to B while its SQLite/Yjs seed is still
  // materializing (or when that load fails).
  const [loadedNodeContent, setLoadedNodeContent] = useState<{
    nodeId: string;
    content: NodeContent | null;
    loadError: boolean;
  } | null>(null);
  const bookContent =
    loadedNodeContent?.nodeId === nodeId ? (loadedNodeContent?.content ?? null) : null;
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  // Highlight agent-changed blocks/summary and clear the cell's "M" as the user
  // reads each spot in place (#17).
  useAgentChangeMarks(scrollEl, 'node', nodeId, isVisible);
  const stickyNoteRail = useEntityStickyNoteRail('node', nodeId);
  const marginNotes = stickyNoteRail.visible;
  const setMarginNotes = stickyNoteRail.setVisible;
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((state) => state.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );
  const commentCount = stickyNoteRail.itemIds.length;
  const toggleComments = useCallback(() => {
    const next = !marginNotes;
    setMarginNotes(next);
    if (!next) setPendingComment(null);
  }, [marginNotes, setMarginNotes]);
  const handleAddCommentRequest = useCallback(
    (request: EditorCommentRequest) => {
      setMarginNotes(true);
      setPendingComment(request);
    },
    [setMarginNotes],
  );
  const outlineIds = outline.map((heading) => heading.id);
  // Nest the flat H1/H2/H3 outline into the scene/beat/note tree so this
  // single-chapter TOC reads identically to the same chapter inside 通览全书.
  const outlineTree = useMemo(() => nestHeadings(outline), [outline]);

  // usecases
  const { renameNode, updateNodeSummary, updateNode, deleteNode } = useBookNode({
    projectId: activeProjectId,
    userId: activeUserId,
  });
  const { getContentByNodeId, updatePlotGridByNodeId } =
    useBookContent({
      userId: activeUserId,
      projectId: activeProjectId,
    });
  const plotPlannerOpen = useUiStore((s) => isVisible && s.plotPlannerOpen);
  const togglePlotPlanner = useUiStore((s) => s.togglePlotPlannerOpen);
  // The planner shows in the dock under the paper; only the focused editor
  // (the one global commands belong to) puts its chapter's grid there.
  const plotPlannerSlot = usePlotPlannerSlot();
  // Plot planner grid persists on its own debounce, independent of the prose
  // save path. Bound to the dock's nodeId (not activeNodeIdRef) so a flush
  // during a node switch writes to the correct row.
  const handlePlotGridPersist = useCallback(
    (targetNodeId: string, mutations: readonly PlotGridMutation[]) =>
      updatePlotGridByNodeId(targetNodeId, mutations),
    [updatePlotGridByNodeId],
  );
  // Element usecase — used by the drift→element conversion path (createElement
  // then updateElement to inject the drift's existing content/summary).
  const { createElement, updateElement } = useBookElement({
    userId: activeUserId,
    projectId: activeProjectId,
  });

  // Drift conversion modal. `null` = closed; otherwise the target picks which
  // candidate list to show (storylines vs categories) and which write path to
  // run on confirm.
  const [conversionTarget, setConversionTarget] = useState<'chapter' | 'element' | null>(null);
  const [conversionPickedId, setConversionPickedId] = useState<string | null>(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  // Drift → group move (3-dot menu "移动到分组…"). Mirrors the element editor's
  // category-picker modal pattern.
  const { moveDriftToGroup } = useDriftGroup({ projectId: activeProjectId });
  const [showGroupModal, setShowGroupModal] = useState(false);
  // Depth-ordered group list for the move modal's <select> (indented by nesting
  // level via leading spaces — <option> can't be styled).
  const driftGroupOptions = useMemo(() => {
    const children = buildDriftGroupChildren(driftGroups);
    const out: Array<{ id: string; label: string; name: string; depth: number }> = [];
    const walk = (key: string, depth: number) => {
      for (const g of children.get(key) ?? []) {
        out.push({ id: g.id, label: `${'  '.repeat(depth)}${g.name}`, name: g.name, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(ROOT_GROUP_KEY, 0);
    return out;
  }, [driftGroups]);
  // for focus at this level
  const editorRef = useRef<ChapterEditorRef>(null);
  const activeNodeIdRef = useRef<string | null>(nodeId ?? null);

  useEffect(() => {
    activeNodeIdRef.current = nodeId ?? null;
  }, [nodeId]);

  const curNode = useDataStore((state) => state.bookNodes.find(node => node.id === nodeId) ?? null);
  // The chapter's place in reading order, for the folio's 「第 N 章」 (the same
  // numbering as the whole-book read-through).
  const chapterNumber = useDataStore((state) =>
    curNode && isChapter(curNode)
      ? state.bookNodes.filter((node) => isChapter(node) && node.bookOrder < curNode.bookOrder).length + 1
      : null,
  );

  const storylineById = useMemo(() => {
    return new Map(storylines.map((storyline) => [storyline.id, storyline]));
  }, [storylines]);

  const curNodePrimaryStorylineId = curNode ? primaryStorylineByNode[curNode.id] ?? null : null;

  // Folder path (top-down, ≤2 levels under the nesting cap) of the drift's
  // containing group, for the editor breadcrumb. Empty for chapters / ungrouped.
  const driftGroupChain = useMemo(() => {
    if (!curNode || !isDrift(curNode) || !curNode.driftGroupId) return [];
    const byId = new Map(driftGroups.map((g) => [g.id, g]));
    const chain: typeof driftGroups = [];
    const seen = new Set<string>();
    let cur = byId.get(curNode.driftGroupId) ?? null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentGroupId ? byId.get(cur.parentGroupId) ?? null : null;
    }
    return chain;
  }, [curNode, driftGroups]);

  const currentStorylineIds = useMemo(() => {
    if (!nodeId || !curNode) return [];
    const mappedIds = nodeStorylineMapping[nodeId] ?? [];
    const ids = curNodePrimaryStorylineId
      ? [
          curNodePrimaryStorylineId,
          ...mappedIds.filter((id) => id !== curNodePrimaryStorylineId),
        ]
      : mappedIds;
    return ids.filter((id, index) => ids.indexOf(id) === index && storylineById.has(id));
  }, [curNode, curNodePrimaryStorylineId, nodeId, nodeStorylineMapping, storylineById]);

  const currentStorylines = useMemo(() => {
    return currentStorylineIds
      .map((id) => storylineById.get(id))
      .filter((storyline): storyline is Storyline => Boolean(storyline));
  }, [currentStorylineIds, storylineById]);

  const mainStoryline =
    (curNodePrimaryStorylineId ? storylineById.get(curNodePrimaryStorylineId) : null) ??
    currentStorylines[0] ??
    null;

  const isDriftNode = curNode ? isDrift(curNode) : false;

  // load content when node changes
  useEffect(() => {
    if (!nodeId) {
      log.error('[NodeEditor] No nodeId provided in URL params');
      return;
    }
    const targetNodeId = nodeId;
    let cancelled = false;

    const fetchContent = async () => {
      try {
        log.debug('[NodeEditor] Fetching content for nodeId', targetNodeId);
        const cont = await getContentByNodeId(targetNodeId);
        if (cancelled || activeNodeIdRef.current !== targetNodeId) {
          return;
        }
        log.debug('[NodeEditor] Fetched content:', cont);
        if (!cont) {
          log.warn(
            '[NodeEditor] No content found for nodeId, editor will seed from Yjs/legacy',
            targetNodeId,
          );
        }
        setLoadedNodeContent({ nodeId: targetNodeId, content: cont, loadError: false });
      } catch (error) {
        if (!cancelled && activeNodeIdRef.current === targetNodeId) {
          log.error('[NodeEditor] Failed to load/create chapter content', error);
          setLoadedNodeContent({ nodeId: targetNodeId, content: null, loadError: true });
        }
      }
    };

    void fetchContent();

    return () => {
      cancelled = true;
    };
  }, [nodeId, getContentByNodeId]);

  const handleTitleUpdate = useCallback(
    async (targetNodeId: string, title: string) => {
      promoteCurrentTab();
      try {
        await renameNode(targetNodeId, title);
      } catch (error) {
        log.error('[NodeEditor] Failed to update title:', error);
      }
    },
    [renameNode, promoteCurrentTab],
  );

  const handleSummaryUpdate = useCallback(
    async (targetNodeId: string, summary: string) => {
      promoteCurrentTab();
      try {
        await updateNodeSummary(targetNodeId, summary);
      } catch (error) {
        log.error('[NodeEditor] Failed to update summary:', error);
      }
    },
    [updateNodeSummary, promoteCurrentTab],
  );

  const handleContentUpdate = useCallback(
    async (
      targetNodeId: string,
      pmJson: string,
      _outlineJson: string,
      _nextWordCount: number,
    ) => {
      // Skip promote+save when content matches the loaded baseline — this filters
      // out phantom onUpdate fires (Yjs initial sync, etc.) that would otherwise
      // silently promote a preview tab on mount.
      if (pmJson === bookContent?.contentJson) return;
      if (isCommandActive && canPromoteOnEdit()) promoteCurrentTab();
      try {
        const persisted = await getContentByNodeId(targetNodeId);
        if (persisted && activeNodeIdRef.current === targetNodeId) {
          setLoadedNodeContent({ nodeId: targetNodeId, content: persisted, loadError: false });
        }
      } catch (error) {
        log.error('[NodeEditor] Failed to reload materialized content:', error);
      }
    },
    [
      bookContent?.contentJson,
      canPromoteOnEdit,
      getContentByNodeId,
      isCommandActive,
      promoteCurrentTab,
    ],
  );

  const isActiveNodeReady = Boolean(
    nodeId && curNode && loadedNodeContent?.nodeId === nodeId,
  );
  const isActiveNodeLoadError = Boolean(
    isActiveNodeReady && loadedNodeContent?.loadError,
  );
  useLayoutEffect(() => {
    if (!isActiveNodeLoadError) return undefined;
    reportReady(true);
    return () => reportReady(false);
  }, [isActiveNodeLoadError, reportReady]);

  const handleEntityClick = useCallback(
    (ref: EntityLinkRef) => openEntityLinkTarget(openEntity, ref),
    [openEntity],
  );

  // The ⁂ menu's "new chapter after" creates the next chapter in reading
  // order and opens it as a kept tab, like the sidebar's 新章节; its title
  // opens selected. The touch shell keeps the decorative ⁂.
  const insertChapter = useChapterInsert({ projectId: activeProjectId, userId: activeUserId });
  const handleInsertAfter = useCallback(
    (afterNodeId: string) => {
      void insertChapter(afterNodeId).then((id) => {
        if (id) openEntity({ entityType: 'node', id }, { preview: false });
      });
    },
    [insertChapter, openEntity],
  );

  const setChapterStorylineEditorNodeId = useUiStore(
    (s) => s.setChapterStorylineEditorNodeId,
  );
  const openStorylineEditor = useCallback(() => {
    if (!nodeId) return;
    setChapterStorylineEditorNodeId(nodeId);
  }, [nodeId, setChapterStorylineEditorNodeId]);

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!nodeId || !curNode) return;

      if (action === 'threadPicker' || action === 'editNodeStorylines') {
        openStorylineEditor();
        return;
      }

      if (action === CONVERT_DRIFT_TO_CHAPTER_ACTION) {
        if (!isDrift(curNode)) return;
        if (storylines.length === 0) {
          alert(t('nodeEditor.alerts.needStoryline'));
          return;
        }
        setConversionPickedId(storylines[0].id);
        setConversionTarget('chapter');
        return;
      }

      if (action === CONVERT_DRIFT_TO_ELEMENT_ACTION) {
        if (!isDrift(curNode)) return;
        if (bookElementCategories.length === 0) {
          alert(t('nodeEditor.alerts.needCategory'));
          return;
        }
        setConversionPickedId(bookElementCategories[0].id);
        setConversionTarget('element');
        return;
      }

      if (action === DRIFT_MOVE_TO_GROUP_ACTION) {
        if (!isDrift(curNode)) return;
        setShowGroupModal(true);
        return;
      }

      if (action.startsWith(SET_STATUS_ACTION_PREFIX)) {
        const next = action.slice(SET_STATUS_ACTION_PREFIX.length) as WritingStatus;
        // Only accept values from the enum that matches this node's kind so
        // chapter and drift status sets stay disjoint (you can't drop a
        // drift node into "finished" via a stale menu, etc.).
        const allowed = isDrift(curNode) ? DRIFT_STATUSES : CHAPTER_WRITING_STATUSES;
        if (!allowed.includes(next as never) || next === curNode.writingStatus) return;
        try {
          await updateNode(nodeId, { writingStatus: next });
        } catch (error) {
          log.error('[NodeEditor] Failed to set writing status:', error);
          alert(t('nodeEditor.alerts.statusUpdateFailed'));
        }
        return;
      }

      if (action === 'deleteNode') {
        const confirmed = await requestConfirmation(
          t('nodeEditor.deleteConfirm', { name: curNode.title }),
        );
        if (!confirmed) return;

        try {
          await deleteNode(nodeId);
          leaveDeletedEntity();
        } catch (error) {
          log.error('[NodeEditor] Failed to delete node:', error);
          alert(t('nodeEditor.alerts.deleteFailed'));
        }
      }
    },
    [
      curNode,
      deleteNode,
      leaveDeletedEntity,
      nodeId,
      openStorylineEditor,
      updateNode,
      storylines,
      bookElementCategories,
      t,
    ],
  );

  // Pending-action consumer: when a left-sidebar context menu queued an
  // action against this node (e.g. drift conversion), pull it off the
  // queue once the node has actually loaded and dispatch it through the
  // same handler the three-dot menu uses. Watching `pendingEntityAction`
  // (not just nodeId/curNode) handles the "same entity already open" case
  // where navigation is a no-op.
  const pendingEntityAction = useUiStore((s) => s.pendingEntityAction);
  const consumeEntityAction = useUiStore((s) => s.consumeEntityAction);
  useEffect(() => {
    if (!isCommandActive) return;
    if (!nodeId || !curNode) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('node', nodeId);
    if (queued) queueMicrotask(() => void handleContextAction(queued));
  }, [
    isCommandActive,
    nodeId,
    curNode,
    pendingEntityAction,
    consumeEntityAction,
    handleContextAction,
  ]);

  const handleConfirmConversion = useCallback(async () => {
    if (!curNode || !nodeId || !conversionTarget || !conversionPickedId) return;
    if (!isDrift(curNode)) {
      // Sanity: somehow the node became a chapter between modal-open and
      // confirm — bail without writing.
      setConversionTarget(null);
      return;
    }

    setConversionBusy(true);
    try {
      if (conversionTarget === 'chapter') {
        // Single write: setting mainStorylineId pulls the drift into the
        // picked storyline (the useBookNode update path also creates the
        // node↔storyline link transactionally), and the status flip from
        // drift→draft puts it on the chapter axis.
        //
        // Drift nodes carry no bookOrder — when we lift one into a chapter
        // we have to assign one. Append to the tail of the global chapter
        // axis, jumping by CHAPTER_ORDER_STRIDE so the new tile lands next
        // to (not overlapping) the current last chapter.
        const maxChapterOrder = useDataStore.getState().bookNodes
          .filter(isChapter)
          .reduce((max, n) => Math.max(max, n.bookOrder), 0);
        await updateNode(nodeId, {
          kind: 'chapter',
          mainStorylineId: conversionPickedId,
          writingStatus: 'draft',
          bookOrder: maxChapterOrder + CHAPTER_ORDER_STRIDE,
          // Grouping is drift-only — drop the group pointer as the node leaves
          // the drift panel (parallels the marker/act unbinds below).
          driftGroupId: null,
        });
        // The node now lives on the book axis — release any timeline marker
        // or act bound to it while it was a drift (binding is drift-only).
        await unbindMarkersForDrift(activeProjectId, nodeId, curNode.title).catch(() => {});
        await unbindActsForDrift(activeProjectId, nodeId).catch(() => {});
      } else {
        // Element conversion is destructive: we lift the drift's title /
        // summary / content into a brand-new BookElement, then delete the
        // drift (its entity_relation rows cascade away with it via the
        // polymorphic cleanup path — those references were rooted at a
        // node-shaped entity that no longer exists).
        //
        // The drift's content may not have been hydrated into bookContent
        // yet (e.g. user opened the menu before the content loader ran),
        // so pull from the repo as the source of truth.
        const liveDriftDoc = getLiveYDoc(makeDocId('node-content', nodeId));
        const liveContentJson = liveDriftDoc
          ? JSON.stringify(
              (await import('y-prosemirror')).yDocToProsemirrorJSON(liveDriftDoc, 'default'),
            )
          : null;
        const driftContent = liveContentJson ? null : await getContentByNodeId(nodeId);
        // Lift the drift's title onto the new element so the rename the user
        // gave the drift carries over. createElement handles the empty-string
        // fallback itself — don't pre-fill 'Untitled' here, that would mask a
        // real empty drift title and leak an English placeholder.
        const created = await createElement({
          categoryId: conversionPickedId,
          name: curNode.title,
        });
        if (!created) throw new Error('createElement returned no row');
        await updateElement(created.id, {
          summary: curNode.summary,
          contentJson: liveContentJson ?? driftContent?.contentJson ?? '{}',
        });
        await deleteNode(nodeId);
        setConversionTarget(null);
        setConversionPickedId(null);
        navigateToElement(created.id);
        return;
      }
      setConversionTarget(null);
      setConversionPickedId(null);
    } catch (error) {
      log.error('[NodeEditor] Drift conversion failed:', error);
      alert(t('nodeEditor.alerts.conversionFailed'));
    } finally {
      setConversionBusy(false);
    }
  }, [
    conversionPickedId,
    conversionTarget,
    createElement,
    curNode,
    deleteNode,
    getContentByNodeId,
    navigateToElement,
    nodeId,
    activeProjectId,
    t,
    updateElement,
    updateNode,
  ]);

  const storylineColor = mainStoryline?.color || 'hsl(var(--accent))';

  return (
    <div
      className="editor-shell"
      style={{
        position: 'relative',
      }}
    >
      {nodeId && curNode && (
        <>
          <EditorTopBar
            editorType="node"
            onMenuAction={handleContextAction}
            shareTarget={{ projectId, kind: 'node', id: curNode.id, title: curNode.title }}
            // mainStorylineId is the source of truth for "is this a drift
            // node" — writingStatus is just the per-axis state.
            nodeWritingStatus={curNode.writingStatus}
            nodeStatusKind={curNode.kind}
            referenceLinkToggle={{
              enabled: entityLinkInteractive,
              onToggle: toggleEntityLinkInteractive,
            }}
            commentToggle={{
              enabled: marginNotes,
              count: commentCount,
              disabled: false,
              onToggle: toggleComments,
            }}
            plotPlannerToggle={{
              enabled: plotPlannerOpen,
              onToggle: togglePlotPlanner,
            }}
          />

          {/* In-chapter plot planner, portaled into the dock under the paper
              that it shares with the Bottom Timeline. Keyed by nodeId so each
              chapter/drift seeds its own grid only after that node's content
              row is ready. */}
          {plotPlannerOpen && isCommandActive && isActiveNodeReady && plotPlannerSlot &&
            createPortal(
              <PlotPlannerDock
                key={`plot-planner:${nodeId}`}
                nodeId={nodeId}
                title={curNode.title}
                color={isDriftNode ? undefined : mainStoryline?.color || undefined}
                drift={isDriftNode}
                initialJson={bookContent?.plotGridJson ?? '{}'}
                onPersist={handlePlotGridPersist}
              />,
              plotPlannerSlot,
            )}

          {/* The semantic TOC stays outside the native scroll tree on the left;
              review markers independently overlay the native scrollbar on the right. */}
          <div className="editor-body" key={nodeId}>
            <EditorOutlineRail
              title={t('nodeEditor.outline.title')}
              items={isActiveNodeReady ? outlineTree : []}
              color={mainStoryline?.color || undefined}
              scrollspyIds={outlineIds}
              onItemClick={(id) => {
                scrollToOutlineAnchor(id, scrollEl);
              }}
            />
            <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
              <div className="editor__spread">
                <article className="page page--entity">
                  {/* Desktop folio: 「第 N 章」, the storyline's dash beside its
                      name in ink, the word count; a drift says its group the
                      same way. The paused mobile shell keeps the coloured names. */}
                  {!isDriftNode && !getPlatformRuntime().isMobileShell && (
                    <div className="page__folio" aria-hidden="true">
                      <span className="page__folio-line">
                        {chapterNumber == null
                          ? t('nodeEditor.folio.chapter')
                          : t('nodeEditor.folio.chapterNumber', { n: chapterNumber })}
                      </span>
                      {mainStoryline && (
                        <span className="page__folio-line page__folio-storyline">
                          <KindMark kind="storyline" color={storylineColor} />
                          {mainStoryline.name}
                        </span>
                      )}
                      <span className="page__folio-line">
                        {canonicalWordCount(curNode) == null
                          ? t('common.counting')
                          : t('nodeEditor.meta.words', {
                              count: canonicalWordCount(curNode)!.toLocaleString(),
                            })}
                      </span>
                    </div>
                  )}

                  {isDriftNode && !getPlatformRuntime().isMobileShell && (
                    <div className="page__folio" aria-hidden="true">
                      <span className="page__folio-line">{t('nodeEditor.folio.drift')}</span>
                      {driftGroupChain.length > 0 && (
                        <span className="page__folio-line page__folio-storyline">
                          <KindMark kind="drift-group" />
                          {driftGroupChain.map((g) => g.name).join(' - ')}
                        </span>
                      )}
                      <span className="page__folio-line">
                        {canonicalWordCount(curNode) == null
                          ? t('common.counting')
                          : t('nodeEditor.meta.words', {
                              count: canonicalWordCount(curNode)!.toLocaleString(),
                            })}
                      </span>
                    </div>
                  )}

                  {!isDriftNode && getPlatformRuntime().isMobileShell && (
                    <div className="page__folio" aria-hidden="true">
                      <span className="page__folio-line">{t('nodeEditor.folio.chapter')}</span>
                      {mainStoryline && (
                        <span className="page__folio-line" style={{ color: storylineColor, fontWeight: 600 }}>
                          {mainStoryline.name}
                        </span>
                      )}
                      <span className="page__folio-line">
                        {canonicalWordCount(curNode) == null
                          ? t('common.counting')
                          : t('nodeEditor.meta.words', {
                              count: canonicalWordCount(curNode)!.toLocaleString(),
                            })}
                      </span>
                    </div>
                  )}

                  {isDriftNode && getPlatformRuntime().isMobileShell && (
                    <div className="page__folio" aria-hidden="true">
                      <span className="page__folio-line">{t('nodeEditor.folio.drift')}</span>
                      {driftGroupChain.length > 0 && (
                        <span className="page__folio-line page__folio-line--accent">
                          {driftGroupChain.map((g) => g.name).join(' - ')}
                        </span>
                      )}
                      <span className="page__folio-line">
                        {canonicalWordCount(curNode) == null
                          ? t('common.counting')
                          : t('nodeEditor.meta.words', {
                              count: canonicalWordCount(curNode)!.toLocaleString(),
                            })}
                      </span>
                    </div>
                  )}

                  {isActiveNodeReady && !isActiveNodeLoadError ? (
                    <ChapterEditor
                      key={nodeId}
                      ref={editorRef}
                      nodeId={nodeId}
                      projectId={activeProjectId}
                      content={bookContent?.contentJson ?? null}
                      title={curNode.title}
                      summary={curNode.summary || ''}
                      onContentUpdate={handleContentUpdate}
                      onTitleUpdate={handleTitleUpdate}
                      onSummaryUpdate={handleSummaryUpdate}
                      onEntityClick={handleEntityClick}
                      onOutlineChange={setOutline}
                      onAddCommentRequest={handleAddCommentRequest}
                      showTitle={true}
                      showSummary={true}
                      editableTitle={true}
                      editableSummary={true}
                      autoFocus={false}
                      minHeight="400px"
                      onReadyChange={reportReady}
                      selectionKey={editorTabSelectionKey(activeProjectId, {
                        entityType: 'node',
                        id: nodeId,
                      })}
                    />
                  ) : isActiveNodeLoadError ? (
                    <EditorDocumentLoadError />
                  ) : (
                    <div style={{ minHeight: 400, display: 'grid', placeItems: 'center' }}>
                      <LoadingStatus label={t('common.loading')} />
                    </div>
                  )}

                  {curNode && isChapter(curNode) && !getPlatformRuntime().isMobileShell ? (
                    <ChapterEndActions
                      projectId={activeProjectId}
                      node={curNode}
                      onInsertAfter={handleInsertAfter}
                      onSetStatus={(_, status) =>
                        void handleContextAction(`${SET_STATUS_ACTION_PREFIX}${status}`)
                      }
                    />
                  ) : (
                    <ChapterEndOrnament />
                  )}
                </article>
              </div>
            </div>
            {marginNotes && (
              <StickyNoteRail
                projectId={activeProjectId}
                targetKind="node"
                targetId={nodeId ?? ''}
                pendingRequest={pendingComment}
                onPendingRequestChange={setPendingComment}
              />
            )}
            <EditorReviewLayer
              projectId={activeProjectId}
              entityType="node"
              id={nodeId}
              scrollEl={scrollEl}
              visibleCommentIds={marginNotes ? stickyNoteRail.itemIds : undefined}
            />
          </div>
        </>
      )}

      {conversionTarget && curNode && (
        <ConversionPickerModal
          target={conversionTarget}
          nodeTitle={curNode.title}
          pickedId={conversionPickedId}
          busy={conversionBusy}
          storylines={storylines}
          categories={bookElementCategories}
          onPick={setConversionPickedId}
          onCancel={() => {
            if (conversionBusy) return;
            setConversionTarget(null);
            setConversionPickedId(null);
          }}
          onConfirm={handleConfirmConversion}
        />
      )}

      {showGroupModal && curNode && isDrift(curNode) && nodeId && !getPlatformRuntime().isMobileShell && (
        // Desktop: the groups are menu rows, the current one bold with a tick.
        <ModalRoot onClose={() => setShowGroupModal(false)} ariaLabel={t('nodeEditor.groupMove.title')}>
          <ModalCard width={360}>
            <ModalHeader
              title={t('nodeEditor.groupMove.title')}
              onClose={() => setShowGroupModal(false)}
              closeLabel={t('common.close')}
            />
            <ModalBody>
              <div className="entity-choice" role="listbox" aria-label={t('nodeEditor.groupMove.title')}>
                {[{ id: '', name: t('nodeEditor.groupMove.root'), depth: 0 }, ...driftGroupOptions].map((g) => {
                  const current = (curNode.driftGroupId ?? '') === g.id;
                  return (
                    <button
                      key={g.id || 'root'}
                      type="button"
                      role="option"
                      aria-selected={current}
                      className={`menu-surface__item entity-choice__row${g.id ? '' : ' entity-choice__row--none'}${
                        current ? ' entity-choice__row--current' : ''
                      }`}
                      style={{ paddingLeft: 14 + g.depth * 16 }}
                      onClick={() => {
                        void moveDriftToGroup(nodeId, g.id || null);
                        setShowGroupModal(false);
                      }}
                    >
                      {g.id && <KindMark kind="drift-group" />}
                      <span>{g.name}</span>
                      {current && <BrushIcon name="check" size={11} className="entity-choice__tick" />}
                    </button>
                  );
                })}
              </div>
            </ModalBody>
          </ModalCard>
        </ModalRoot>
      )}

      {showGroupModal && curNode && isDrift(curNode) && nodeId && getPlatformRuntime().isMobileShell && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(28, 24, 19, 0.32)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            padding: 12,
            zIndex: 'var(--z-popover)',
          }}
          onClick={() => setShowGroupModal(false)}
        >
          <div
            style={{
              background: 'hsl(var(--page))',
              border: '1px solid hsl(var(--rule-strong))',
              borderRadius: 2,
              boxSizing: 'border-box',
              padding: 24,
              width: 'min(360px, 100%)',
              minWidth: 0,
              maxWidth: '100%',
              boxShadow: '0 18px 50px rgba(28, 24, 19, 0.22)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>
              {t('nodeEditor.groupMove.title')}
            </h3>
            <select
              value={curNode.driftGroupId ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                void moveDriftToGroup(nodeId, val || null);
                setShowGroupModal(false);
              }}
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid hsl(var(--rule-strong))',
                borderRadius: 4,
                padding: '8px 12px',
                outline: 'none',
                cursor: 'pointer',
                background: 'hsl(var(--surface))',
                whiteSpace: 'pre',
              }}
            >
              <option value="">{t('nodeEditor.groupMove.root')}</option>
              {driftGroupOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
});

interface ConversionPickerModalProps {
  target: 'chapter' | 'element';
  nodeTitle: string;
  pickedId: string | null;
  busy: boolean;
  storylines: Storyline[];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  onPick: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConversionPickerModal({
  target,
  nodeTitle,
  pickedId,
  busy,
  storylines,
  categories,
  onPick,
  onCancel,
  onConfirm,
}: ConversionPickerModalProps) {
  const { t } = useTranslation();
  const isChapter = target === 'chapter';
  // Desktop wears sand and glass; the paused mobile shell keeps its own look.
  const glass = !getPlatformRuntime().isMobileShell;
  const options = isChapter
    ? storylines.map((s) => ({ id: s.id, name: s.name, color: s.color }))
    : categories.map((c) => ({ id: c.id, name: c.name, color: c.color }));
  const title = isChapter ? t('nodeEditor.conversion.toChapter') : t('nodeEditor.conversion.toElement');
  const subtitle = isChapter
    ? t('nodeEditor.conversion.chapterSubtitle')
    : t('nodeEditor.conversion.elementSubtitle');
  const confirmLabel = isChapter
    ? t('nodeEditor.conversion.toChapter')
    : t('nodeEditor.conversion.toElement');

  return (
    <ModalRoot onClose={onCancel} ariaLabel={title}>
      <ModalCard width={460}>
        <ModalHeader
          title={title}
          subtitle={nodeTitle || t('common.untitled')}
          description={subtitle}
        />
        <ModalBody className="conversion-picker__body">
          {glass && options.length > 0 && (
            // Desktop: cards of resting glass in each storyline's or category's
            // colour; the chosen one is that colour's still selected glass.
            <div className="entity-choice-grid" role="radiogroup" aria-label={title}>
              {options.map((opt) => (
                <button
                  type="button"
                  key={opt.id}
                  role="radio"
                  aria-checked={pickedId === opt.id}
                  className={`entity-choice-card glass glass--rest${pickedId === opt.id ? ' is-on' : ''}`}
                  style={{ '--choice-c': opt.color || 'hsl(var(--accent))' } as React.CSSProperties}
                  onClick={() => onPick(opt.id)}
                >
                  <KindMark kind={isChapter ? 'storyline' : 'category'} color={opt.color || undefined} />
                  <span>{opt.name || t('common.untitled')}</span>
                </button>
              ))}
            </div>
          )}
          {options.length === 0 && (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'hsl(var(--ink-4))',
                fontStyle: 'italic',
                fontSize: 13,
              }}
            >
              {isChapter ? t('nodeEditor.conversion.noStorylines') : t('nodeEditor.conversion.noCategories')}
            </div>
          )}
          {!glass && options.map((opt) => {
            const selected = pickedId === opt.id;
            const color = opt.color || 'hsl(var(--accent))';
            return (
              <button
                type="button"
                key={opt.id}
                onClick={() => onPick(opt.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: selected ? `1px solid ${color}` : '1px solid hsl(var(--rule))',
                  background: selected
                    ? `color-mix(in srgb, ${color} 8%, transparent)`
                    : 'hsl(var(--paper))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 14,
                  fontWeight: selected ? 600 : 500,
                  color: 'hsl(var(--ink-1))',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {opt.name || t('common.untitled')}
                </span>
              </button>
            );
          })}
        </ModalBody>
        <ModalActions>
          <Button onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={busy || !pickedId || options.length === 0}
          >
            {busy ? t('nodeEditor.conversion.converting') : confirmLabel}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
