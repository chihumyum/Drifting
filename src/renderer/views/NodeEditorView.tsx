import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import {
  BookNode,
  CHAPTER_WRITING_STATUSES,
  CHAPTER_ORDER_STRIDE,
  DRIFT_STATUSES,
  isChapter,
  isDrift,
  type WritingStatus,
} from '../domain/book-node';
import type { Storyline } from '../domain/storyline';
import { ChapterEditor, type ChapterEditorRef } from '../components/editor/ChapterEditor';
import { CommentRail } from '../components/editor/CommentRail';
import { EditorReviewLayer } from '../components/editor/EditorReviewLayer';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
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
  EditorCrumb,
  EditorTopBar,
  SET_STATUS_ACTION_PREFIX,
} from '../components/editor/EditorTopBar';
import { useBookElement } from '../usecase/useBookElement';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { commentBelongsToEntity, commentIdsRelatedToEntity } from '../domain/comment';
import { useSettingsStore } from '../store/settings-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { enqueueShadowReview } from '../lib/shadow/job-recorder';
import { useCanPromoteOnEdit, usePromoteCurrentTab, useUiStore } from '../store/ui-store';
import { countWordsInPmJson } from '../lib/word-count';
import { editorTabSelectionKey } from '../lib/editor-selection-memory';
import type { EditorCommentRequest } from '../hooks/useEntityEditor';
import { useEntityMarginNotes } from '../hooks/useEntityMarginNotes';

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
  const activeOutlineId = useOutlineScrollspy(
    scrollEl,
    outline.map((h) => h.id),
  );

  const wordCountBackfillRef = useRef<string | null>(null);
  // usecases
  const { renameNode, updateNodeSummary, updateNode, deleteNode } = useBookNode({
    projectId: activeProjectId,
    userId: activeUserId,
  });
  const { getContentByNodeId, updateContentByNodeId, createContent } = useBookContent({
    userId: activeUserId,
    projectId: activeProjectId,
  });
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

  const chapterIndex = useMemo(() => {
    if (!nodeId) return 0;
    const idx = sameStorylineNodes.findIndex((n) => n.id === nodeId);
    return idx >= 0 ? idx + 1 : 0;
  }, [nodeId, sameStorylineNodes]);

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

  // Persists wordCount onto BookNode if it diverged from what's in state.
  // Dedup is essential: typing within a word doesn't change the count and
  // we don't want a DB write per keystroke when nothing changed.
  const persistWordCountIfChanged = useCallback(
    (targetNodeId: string, nextWordCount: number) => {
      const current = useDataStore.getState().bookNodes.find((n) => n.id === targetNodeId);
      if (!current || current.wordCount === nextWordCount) return;
      void updateNode(targetNodeId, { wordCount: nextWordCount }).catch((error) => {
        log.error('[NodeEditor] Failed to persist wordCount:', error);
      });
    },
    [updateNode],
  );

  const handleContentUpdate = useCallback(
    async (
      targetNodeId: string,
      pmJson: string,
      outlineJson: string,
      nextWordCount: number,
    ) => {
      // Skip promote+save when content matches the loaded baseline — this filters
      // out phantom onUpdate fires (Yjs initial sync, etc.) that would otherwise
      // silently promote a preview tab on mount.
      if (pmJson === bookContent?.contentJson) return;
      if (canPromoteOnEdit()) promoteCurrentTab();
      try {
        const existing = await getContentByNodeId(targetNodeId);
        if (existing) {
          const updated = await updateContentByNodeId(targetNodeId, {
            contentJson: pmJson,
            outlineJson,
          });
          if (updated && activeNodeIdRef.current === targetNodeId) {
            setBookContent(updated);
          }
        } else {
          const created = await createContent(targetNodeId, { contentJson: pmJson, outlineJson });
          if (activeNodeIdRef.current === targetNodeId) {
            setBookContent(created);
          }
        }
        persistWordCountIfChanged(targetNodeId, nextWordCount);
      } catch (error) {
        log.error('[NodeEditor] Failed to update content:', error);
      }
    },
    [bookContent?.contentJson, canPromoteOnEdit, createContent, getContentByNodeId, updateContentByNodeId, persistWordCountIfChanged, promoteCurrentTab],
  );

  // One-shot backfill: legacy nodes whose word_count is still 0 but whose
  // saved content has text. We compute from pmJson once per node-open so the
  // bar/folio show the right number before the user types anything. Guarded
  // by a ref so we don't spam updates if React re-runs the effect.
  useEffect(() => {
    if (!nodeId || !curNode || !bookContent) return;
    if (curNode.wordCount > 0) return;
    if (wordCountBackfillRef.current === nodeId) return;
    const computed = countWordsInPmJson(bookContent.contentJson);
    if (computed <= 0) return;
    wordCountBackfillRef.current = nodeId;
    void updateNode(nodeId, { wordCount: computed }).catch((error) => {
      log.error('[NodeEditor] wordCount backfill failed:', error);
      wordCountBackfillRef.current = null;
    });
  }, [bookContent, curNode, nodeId, updateNode]);

  useEffect(() => {
    wordCountBackfillRef.current = null;
  }, [nodeId]);

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
          alert('请先在左侧或时间轴新建一条 Storyline，才能把 drift 转换为章节。');
          return;
        }
        setConversionPickedId(storylines[0].id);
        setConversionTarget('chapter');
        return;
      }

      if (action === CONVERT_DRIFT_TO_ELEMENT_ACTION) {
        if (!isDrift(curNode)) return;
        if (bookElementCategories.length === 0) {
          alert('请先在元素超视图新建一个 Category，才能把 drift 转换为元素。');
          return;
        }
        setConversionPickedId(bookElementCategories[0].id);
        setConversionTarget('element');
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
          // Marking a chapter finished OPTIONALLY runs it through shadow review
          // first — gated by shadowAutoRun ("完成时自动审阅"). When on: lock it
          // (waiting_review) + enqueue; shadow then pushes it to finished (clean)
          // or back to draft (issues surface as comments). When off — or for drift
          // nodes / the 'draft' option — set the status directly; the user can
          // still review by hand later (复审 / 复审全书). Deps-change re-review is
          // never automatic now; it only surfaces as the「需复审」reminder. Read the
          // toggle imperatively so the handler always sees the live value.
          const autoReviewOnFinish = useSettingsStore.getState().shadowAutoRun;
          if (next === 'finished' && !isDrift(curNode) && autoReviewOnFinish) {
            await updateNode(nodeId, { writingStatus: 'waiting_review' });
            // Durable enqueue: persists a 'queued' row first so a restart resumes it.
            await enqueueShadowReview(nodeId, activeProjectId);
          } else {
            await updateNode(nodeId, { writingStatus: next });
          }
        } catch (error) {
          log.error('[NodeEditor] Failed to set writing status:', error);
          alert('Failed to update writing status. Please try again.');
        }
        return;
      }

      if (action === 'deleteNode') {
        const confirmed = window.confirm(`Delete node "${curNode.title}"?`);
        if (!confirmed) return;

        try {
          await deleteNode(nodeId);
          leaveDeletedEntity();
        } catch (error) {
          log.error('[NodeEditor] Failed to delete node:', error);
          alert('Failed to delete node. Please try again.');
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
          mainStorylineId: conversionPickedId,
          writingStatus: 'draft',
          bookOrder: maxChapterOrder + CHAPTER_ORDER_STRIDE,
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
        const driftContent = await getContentByNodeId(nodeId);
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
          contentJson: driftContent?.contentJson ?? '{}',
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
      alert('转换失败，请重试。');
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
    updateElement,
    updateNode,
  ]);

  const storylineColor = mainStoryline?.color || '#8A2A1E';
  const chapterRoman = chapterIndex > 0 ? toRoman(chapterIndex) : '–';

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
            // node" — writingStatus is just the per-axis state and can be
            // stale (e.g. pre-migration drift rows still carrying 'draft').
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
            right={
              <>
                <span>{curNode.wordCount.toLocaleString()} 字</span>
                {currentStorylines.length > 1 && (
                  <>
                    <span className="editor-bar__sep">·</span>
                    <span>{currentStorylines.length} storylines</span>
                  </>
                )}
              </>
            }
          >
            {!isDriftNode && (
              <EditorCrumb
                dotColor={storylineColor}
                dropdown={
                  <>
                    {storylines.length === 0 ? (
                      <div className="crumb-dropdown__empty">No storylines yet</div>
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
                              style={{ background: s.color || '#8A2A1E' }}
                            />
                            <span>{s.name}</span>
                          </div>
                        );
                      })
                    )}
                  </>
                }
              >
                <span>{mainStoryline?.name ?? 'No storyline'}</span>
              </EditorCrumb>
            )}

            <EditorCrumb
              dropdown={
                breadcrumbSiblingNodes.length === 0 ? (
                  <div className="crumb-dropdown__empty">
                    {isDriftNode ? 'No drifts yet' : 'No chapters'}
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
                        <span>{n.title || 'Untitled'}</span>
                      </div>
                    );
                  })
                )
              }
            >
              <span className="editor-crumb-title">{curNode.title || 'Untitled'}</span>
            </EditorCrumb>
          </EditorTopBar>

          {/* Editor body: TOC sits OUTSIDE the scroll container as a layout
              sibling, so it stays put without relying on position:sticky. */}
          <div className="editor-body">
            <EditorOutlinePanel
              title="本章 · OUTLINE"
              items={outline.map<OutlineEntry>((h) => ({
                id: h.id,
                level: h.level,
                text: h.text,
              }))}
              activeId={activeOutlineId}
              onItemClick={(id) => scrollToOutlineAnchor(id, scrollEl)}
              emptyHint="— 用 H1 / H2 / H3 标题构建大纲 —"
            />
            <div className={`editor-scroll${marginNotes ? ' editor-scroll--comments' : ''}`} ref={setScrollEl}>
              <div className="editor__spread">
                <article className="page">
                  {!isDriftNode && (
                    <div className="page__folio" aria-hidden="true">
                      <span className="page__folio-line">Chapter</span>
                      <span className="page__folio-line page__folio-line--accent">{chapterRoman}</span>
                      {mainStoryline && (
                        <span className="page__folio-line" style={{ color: storylineColor, fontWeight: 600 }}>
                          {mainStoryline.name}
                        </span>
                      )}
                      <span className="page__folio-line">{curNode.wordCount.toLocaleString()} 字</span>
                    </div>
                  )}

                  {!isDriftNode && mainStoryline && (
                    <div className="page__chapter-mark">— {mainStoryline.name} —</div>
                  )}

                  <ChapterEditor
                    key={`${nodeId}:${curNode.writingStatus === 'waiting_review' ? 'ro' : 'rw'}`}
                    ref={editorRef}
                    nodeId={nodeId}
                    projectId={activeProjectId}
                    content={bookContent?.contentJson ?? null}
                    title={curNode.title}
                    summary={curNode.summary || ''}
                    readOnly={curNode.writingStatus === 'waiting_review'}
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
                layout — mirrors the EditorOutlinePanel pattern on the left.
                Page stays centered regardless of whether the rail is open. */}
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
  const isChapter = target === 'chapter';
  const options = isChapter
    ? storylines.map((s) => ({ id: s.id, name: s.name, color: s.color }))
    : categories.map((c) => ({ id: c.id, name: c.name, color: c.color }));
  const title = isChapter ? '转换为章节' : '转换为元素';
  const subtitle = isChapter
    ? '选择该 drift 归属的 storyline。状态会重置为 draft。'
    : '选择该 drift 归属的 category。drift 节点会被删除，内容迁移到新建元素中。';
  const confirmLabel = isChapter ? '转换为章节' : '转换为元素';

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        background: 'rgba(35, 28, 20, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: 'min(460px, 100%)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#fefdfb',
          border: '1px solid hsl(var(--accent-border))',
          borderRadius: 10,
          boxShadow: '0 18px 50px rgba(42, 26, 10, 0.22)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            padding: '20px 22px 14px',
            borderBottom: '1px solid rgba(184, 153, 104, 0.18)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: '#2a1a0a' }}>{title}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#7a6a56' }}>{nodeTitle || 'Untitled'}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: '#a39787', lineHeight: 1.4 }}>
            {subtitle}
          </div>
        </div>

        <div
          style={{
            padding: 14,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minHeight: 0,
            flex: 1,
          }}
        >
          {options.length === 0 && (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: '#a39787',
                fontStyle: 'italic',
                fontSize: 13,
              }}
            >
              {isChapter ? '没有可用的 Storyline' : '没有可用的 Category'}
            </div>
          )}
          {options.map((opt) => {
            const selected = pickedId === opt.id;
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
                  borderRadius: 6,
                  border: selected
                    ? `1px solid ${opt.color || '#b89968'}`
                    : '1px solid rgba(184, 153, 104, 0.18)',
                  background: selected ? `${opt.color || '#b89968'}14` : '#fffaf2',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 14,
                  fontWeight: selected ? 600 : 500,
                  color: '#2a1a0a',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: opt.color || '#b89968',
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
                  {opt.name || 'Untitled'}
                </span>
              </button>
            );
          })}
        </div>

        <div
          style={{
            padding: '12px 18px 16px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            borderTop: '1px solid rgba(184, 153, 104, 0.12)',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid rgba(184, 153, 104, 0.4)',
              background: 'transparent',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 13,
              color: '#5a4a3a',
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !pickedId || options.length === 0}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background:
                busy || !pickedId || options.length === 0
                  ? 'hsl(var(--ink-4))'
                  : 'hsl(var(--accent))',
              color: 'hsl(var(--accent-foreground))',
              cursor: busy || !pickedId || options.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {busy ? '转换中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
