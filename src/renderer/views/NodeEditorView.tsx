import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import {
  BookNode,
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
import { DesktopCommentRail as CommentRail } from '../features/comments/desktop/DesktopCommentRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import { PlotPlannerDock } from '../components/editor/PlotPlannerDock';
import type { PlotGridMutation } from '../domain/plot-grid';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings } from '../components/editor/outline-rail-model';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useAgentChangeMarks } from '../hooks/useAgentChangeMarks';
import { unbindMarkersForDrift } from '../hooks/useTimelineMarkers';
import { unbindActsForDrift } from '../usecase/useBookAct';
import type { OutlineItem } from '../lib/outline';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import {
  CONVERT_DRIFT_TO_CHAPTER_ACTION,
  CONVERT_DRIFT_TO_ELEMENT_ACTION,
  DRIFT_MOVE_TO_GROUP_ACTION,
  EditorCrumb,
  EditorTopBar,
  SET_STATUS_ACTION_PREFIX,
} from '../components/editor/EditorTopBar';
import { useDriftGroup } from '../usecase/useDriftGroup';
import { ROOT_GROUP_KEY, buildDriftGroupChildren } from '../domain/drift-group';
import { useBookElement } from '../usecase/useBookElement';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { commentBelongsToEntity, commentIdsRelatedToEntity } from '../domain/comment';
import { useSettingsStore } from '../store/settings-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { Button } from '../components/ui/Button';
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
import { useEntityMarginNotes } from '../hooks/useEntityMarginNotes';
import { getLiveYDoc } from '../lib/yjs-doc-registry';
import { makeDocId } from '../lib/yjs-doc-id';

const ROMAN_NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function toRoman(n: number): string {
  if (n <= 0) return String(n);
  if (n < ROMAN_NUMERALS.length) return ROMAN_NUMERALS[n];
  // Fallback simple Roman composition for >10
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [v, s] of map) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

const log = loglevel.getLogger('NodeEditorView');
log.setLevel(loglevel.levels.ERROR);
// log.setLevel(loglevel.levels.DEBUG);

// In split-pane mode this view is mounted directly (not via Outlet), so the
// URL won't always reflect the side this instance is rendering. Pass the leaf
// id explicitly via `nodeIdOverride` and we'll use that instead of useParams.
export function NodeEditorView({ nodeIdOverride }: { nodeIdOverride?: string } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    navigateToElement,
    leaveDeletedEntity,
    navigateToNode,
    navigateToStoryline,
    navigateToCategory,
  } = useProjectNavigation();
  const params = useParams<{ nodeId: string; projectId: string }>();
  const nodeId = nodeIdOverride ?? params.nodeId;
  const projectId = params.projectId;
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
    bookNodes,
    storylines,
    nodeStorylineMapping,
    storylineNodeMapping,
    comments,
    entityRelations,
    bookElementCategories,
    primaryStorylineByNode,
  } = useDataStore();
  const driftGroups = useDataStore((s) => s.driftGroups);
  // this component only render one node
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  const [isContentLoaded, setIsContentLoaded] = useState(false);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [pendingComment, setPendingComment] = useState<EditorCommentRequest | null>(null);
  // Highlight agent-changed blocks/summary and clear the cell's "M" as the user
  // reads each spot in place (#17).
  useAgentChangeMarks(scrollEl, 'node', nodeId);
  const [marginNotes, setMarginNotes] = useEntityMarginNotes('node', nodeId);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((state) => state.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );
  // Count comments about this chapter via EITHER mechanism (target_* columns or
  // a relation edge), so the toolbar button enables + the rail opens even when
  // the only notes are right-sidebar TODOs linked by relation. Mirrors
  // CommentRail's loose filter.
  const relatedCommentIds = useMemo(
    () => commentIdsRelatedToEntity(entityRelations, activeProjectId, 'node', nodeId ?? ''),
    [entityRelations, activeProjectId, nodeId],
  );
  const commentCount = useMemo(
    () =>
      comments.filter(
        (comment) =>
          comment.projectId === activeProjectId &&
          comment.status !== 'converted' &&
          commentBelongsToEntity(comment, 'node', nodeId ?? '', relatedCommentIds),
      ).length,
    [activeProjectId, comments, nodeId, relatedCommentIds],
  );
  const toggleComments = useCallback(() => {
    // The rail can always be toggled — with no comments it just shows an empty
    // column, so the user can open it to add the first note.
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
  const { activeId: activeOutlineId, pin: pinOutline } = useOutlineScrollspy(
    scrollEl,
    outline.map((heading) => heading.id),
  );
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
  const plotPlannerOpen = useUiStore((s) => s.plotPlannerOpen);
  const togglePlotPlanner = useUiStore((s) => s.togglePlotPlannerOpen);
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
    const out: Array<{ id: string; label: string }> = [];
    const walk = (key: string, depth: number) => {
      for (const g of children.get(key) ?? []) {
        out.push({ id: g.id, label: `${'  '.repeat(depth)}${g.name}` });
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

  // get nodeId from url params
  useEffect(() => {
    if (!nodeId) {
      navigate('/', { replace: true });
    }
  }, [nodeId, navigate]);

  const curNode = useMemo<BookNode | null>(() => {
    if (!nodeId) {
      return null;
    }

    return bookNodes.find((n) => n.id === nodeId) || null;
  }, [bookNodes, nodeId]);

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

  // Nodes in the current main storyline, sorted by their position on the timeline
  const bookNodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);
  const sameStorylineNodes = useMemo(() => {
    if (!mainStoryline) return [] as BookNode[];
    const ids = storylineNodeMapping[mainStoryline.id] ?? [];
    return ids
      .map((id) => bookNodeById.get(id))
      .filter((n): n is BookNode => Boolean(n))
      .filter(isChapter)
      .sort((a, b) => a.bookOrder - b.bookOrder);
  }, [bookNodeById, mainStoryline, storylineNodeMapping]);

  // Nodes shown in the title-level breadcrumb dropdown:
  // - drift node → all drift nodes (so users can jump between drifts)
  // - chapter in a storyline → chapters in that storyline (current behavior)
  // - chapter without a storyline → all chapters without a storyline
  const breadcrumbSiblingNodes = useMemo<BookNode[]>(() => {
    if (!curNode) return [];
    if (isDrift(curNode)) {
      return bookNodes.filter(isDrift);
    }
    if (mainStoryline) {
      return sameStorylineNodes;
    }
    return bookNodes
      .filter(isChapter)
      .filter((n) => !primaryStorylineByNode[n.id])
      .sort((a, b) => a.bookOrder - b.bookOrder);
  }, [bookNodes, curNode, mainStoryline, primaryStorylineByNode, sameStorylineNodes]);

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
        setBookContent(cont);
      } catch (error) {
        if (!cancelled && activeNodeIdRef.current === targetNodeId) {
          log.error('[NodeEditor] Failed to load/create chapter content', error);
        }
      }

      if (cancelled || activeNodeIdRef.current !== targetNodeId) {
        return;
      }
      setLoadedNodeId(targetNodeId);
      setIsContentLoaded(true);
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
      if (canPromoteOnEdit()) promoteCurrentTab();
      try {
        const persisted = await getContentByNodeId(targetNodeId);
        if (persisted && activeNodeIdRef.current === targetNodeId) {
          setBookContent(persisted);
        }
      } catch (error) {
        log.error('[NodeEditor] Failed to reload materialized content:', error);
      }
    },
    [bookContent?.contentJson, canPromoteOnEdit, getContentByNodeId, promoteCurrentTab],
  );

  const isActiveNodeReady = Boolean(
    nodeId && curNode && isContentLoaded && loadedNodeId === nodeId,
  );

  const handleEntityClick = useCallback(
    (ref: EntityLinkRef) => {
      if (ref.targetKind === 'element') {
        navigateToElement(ref.targetId);
      } else if (ref.targetKind === 'node') {
        navigateToNode(ref.targetId);
      } else if (ref.targetKind === 'storyline') {
        navigateToStoryline(ref.targetId);
      } else if (ref.targetKind === 'category') {
        navigateToCategory(ref.targetId);
      }
      // patch navigation isn't wired up here yet.
    },
    [navigateToCategory, navigateToElement, navigateToNode, navigateToStoryline],
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
        const confirmed = window.confirm(t('nodeEditor.deleteConfirm', { name: curNode.title }));
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
      activeProjectId,
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
    if (!nodeId || !curNode) return;
    if (!pendingEntityAction) return;
    const queued = consumeEntityAction('node', nodeId);
    if (queued) void handleContextAction(queued);
  }, [nodeId, curNode, pendingEntityAction, consumeEntityAction, handleContextAction]);

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
        const maxChapterOrder = bookNodes
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
    bookNodes,
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
      {isActiveNodeReady && nodeId && curNode && (
        <>
          <EditorTopBar
            editorType="node"
            onMenuAction={handleContextAction}
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
            right={
              currentStorylines.length > 1 ? (
                <span>{t('nodeEditor.meta.storylines', { count: currentStorylines.length })}</span>
              ) : undefined
            }
          >
            {!isDriftNode && (
              <EditorCrumb
                dotColor={storylineColor}
                dropdown={
                  <>
                    {storylines.length === 0 ? (
                      <div className="crumb-dropdown__empty">{t('nodeEditor.empty.noStorylines')}</div>
                    ) : (
                      storylines.map((s) => {
                        const isActive = s.id === mainStoryline?.id;
                        return (
                          <div
                            key={s.id}
                            className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                            onClick={() => navigateToStoryline(s.id)}
                          >
                            <span
                              className="crumb-dropdown__dot"
                              style={{ background: s.color || 'hsl(var(--accent))' }}
                            />
                            <span>{s.name}</span>
                          </div>
                        );
                      })
                    )}
                  </>
                }
              >
                <span>{mainStoryline?.name ?? t('nodeEditor.empty.noStoryline')}</span>
              </EditorCrumb>
            )}

            {/* Drift folder path — the group hierarchy (≤2 levels) the drift
                lives in. Display-only context: groups have no editor of their
                own, and relocating the drift here read as a navigation. Moving
                between groups now lives only in the 3-dot menu's「移动到分组…」. */}
            {isDriftNode &&
              driftGroupChain.map((g) => (
                <EditorCrumb key={g.id}>
                  <span>{g.name}</span>
                </EditorCrumb>
              ))}

            <EditorCrumb
              dropdown={
                breadcrumbSiblingNodes.length === 0 ? (
                  <div className="crumb-dropdown__empty">
                    {isDriftNode ? t('nodeEditor.empty.noDrifts') : t('nodeEditor.empty.noChapters')}
                  </div>
                ) : (
                  breadcrumbSiblingNodes.map((n, idx) => {
                    const isActive = n.id === nodeId;
                    const showNum = isChapter(n) && Boolean(mainStoryline);
                    return (
                      <div
                        key={n.id}
                        className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                        onClick={() => {
                          if (!isActive) navigateToNode(n.id);
                        }}
                      >
                        {showNum && (
                          <span className="crumb-dropdown__num">{toRoman(idx + 1)}</span>
                        )}
                        <span>{n.title || t('common.untitled')}</span>
                      </div>
                    );
                  })
                )
              }
            >
              <span className="editor-crumb-title">{curNode.title || t('common.untitled')}</span>
            </EditorCrumb>
          </EditorTopBar>

          {/* In-chapter plot planner: a top dock between the bar and the prose,
              pushing the editor down. Keyed by nodeId so each chapter/drift
              seeds its own grid. Gated on loadedNodeId so it mounts only once
              this node's plotGridJson is in hand. */}
          {plotPlannerOpen && nodeId && loadedNodeId === nodeId && (
            <PlotPlannerDock
              key={nodeId}
              nodeId={nodeId}
              initialJson={bookContent?.plotGridJson ?? '{}'}
              onPersist={handlePlotGridPersist}
            />
          )}

          {/* The semantic TOC scrollbar stays outside the native scroll tree so
              labels, viewport thumb and review lanes share one fixed map. */}
          <div className="editor-body">
            <EditorOutlineRail
              title={t('nodeEditor.outline.title')}
              items={outlineTree}
              activeId={activeOutlineId}
              onItemClick={(id) => {
                pinOutline(id);
                scrollToOutlineAnchor(id, scrollEl);
              }}
            />
            <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
              <div className="editor__spread">
                <article className="page page--entity">
                  {!isDriftNode && (
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

                  {isDriftNode && (
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
                    selectionKey={editorTabSelectionKey(activeProjectId, {
                      entityType: 'node',
                      id: nodeId,
                    })}
                  />

                  <div className="page__ornament" aria-hidden="true">⁂</div>
                </article>
              </div>
            </div>
            {/* Comment rail lives OUTSIDE .editor-scroll so it can be absolutely
                positioned against .editor-body without participating in flex
                layout — mirrors the semantic outline rail on the left.
                Page stays centered without either rail entering layout flow. */}
            {marginNotes && (
              <CommentRail
                projectId={activeProjectId}
                targetKind="node"
                targetId={nodeId ?? ''}
                scrollEl={scrollEl}
                pendingRequest={pendingComment}
                onPendingRequestChange={setPendingComment}
              />
            )}
            <EditorReviewLayer
              projectId={activeProjectId}
              entityType="node"
              id={nodeId}
              scrollEl={scrollEl}
              commentsVisible={marginNotes}
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

      {showGroupModal && curNode && isDrift(curNode) && nodeId && (
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
}

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
          {options.map((opt) => {
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
