import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useStoryline } from '../usecase/useStoryline';
import { useBookContent } from '../usecase/useBookContent';
import { BookNode } from '../domain/book-node';
import type { Storyline } from '../domain/storyline';
import { ChapterEditor, type ChapterEditorRef } from '../components/editor/ChapterEditor';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { usePromoteCurrentTab } from '../store/ui-store';
import { countWordsInPmJson } from '../lib/word-count';

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

export function NodeEditorView() {
  // stuff for geting a node
  const navigate = useNavigate();
  const { navigateToElement, navigateToHome, navigateToNode, navigateToStoryline } =
    useProjectNavigation();
  const { nodeId, projectId } = useParams<{ nodeId: string; projectId: string }>();
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
  const { bookNodes, storylines, nodeStorylineMapping, storylineNodeMapping } = useDataStore();
  // this component only render one node
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  const [isContentLoaded, setIsContentLoaded] = useState(false);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [editingStorylines, setEditingStorylines] = useState(false);
  const [draftStorylineIds, setDraftStorylineIds] = useState<string[]>([]);
  const [draftMainStorylineId, setDraftMainStorylineId] = useState<string | null>(null);
  const wordCountBackfillRef = useRef<string | null>(null);
  // usecases
  const { renameNode, updateNodeSummary, updateNode, deleteNode } = useBookNode({
    projectId: activeProjectId,
    userId: activeUserId,
  });
  const { setNodeStorylines } = useStoryline({
    projectId: activeProjectId,
    userId: activeUserId,
  });
  const { getContentByNodeId, updateContentByNodeId, createContent } = useBookContent({
    userId: activeUserId,
    projectId: activeProjectId,
  });
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

  const currentStorylineIds = useMemo(() => {
    if (!nodeId || !curNode) return [];
    const mappedIds = nodeStorylineMapping[nodeId] ?? [];
    const ids = curNode.mainStorylineId
      ? [curNode.mainStorylineId, ...mappedIds.filter((id) => id !== curNode.mainStorylineId)]
      : mappedIds;
    return ids.filter((id, index) => ids.indexOf(id) === index && storylineById.has(id));
  }, [curNode, nodeId, nodeStorylineMapping, storylineById]);

  const currentStorylines = useMemo(() => {
    return currentStorylineIds
      .map((id) => storylineById.get(id))
      .filter((storyline): storyline is Storyline => Boolean(storyline));
  }, [currentStorylineIds, storylineById]);

  const mainStoryline =
    (curNode ? storylineById.get(curNode.mainStorylineId) : null) ?? currentStorylines[0] ?? null;

  // Nodes in the current main storyline, sorted by their position on the timeline
  const bookNodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);
  const sameStorylineNodes = useMemo(() => {
    if (!mainStoryline) return [] as BookNode[];
    const ids = storylineNodeMapping[mainStoryline.id] ?? [];
    return ids
      .map((id) => bookNodeById.get(id))
      .filter((n): n is BookNode => Boolean(n))
      .sort((a, b) => a.start - b.start);
  }, [bookNodeById, mainStoryline, storylineNodeMapping]);

  const chapterIndex = useMemo(() => {
    if (!nodeId) return 0;
    const idx = sameStorylineNodes.findIndex((n) => n.id === nodeId);
    return idx >= 0 ? idx + 1 : 0;
  }, [nodeId, sameStorylineNodes]);

  useEffect(() => {
    if (!editingStorylines) return;
    if (draftStorylineIds.length === 0) {
      if (draftMainStorylineId) {
        setDraftMainStorylineId(null);
      }
      return;
    }
    if (!draftMainStorylineId || !draftStorylineIds.includes(draftMainStorylineId)) {
      setDraftMainStorylineId(draftStorylineIds[0]);
    }
  }, [draftMainStorylineId, draftStorylineIds, editingStorylines]);

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
      promoteCurrentTab();
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
    [createContent, getContentByNodeId, updateContentByNodeId, persistWordCountIfChanged, promoteCurrentTab],
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

  const handleElementClick = useCallback(
    (elementId: string) => {
      navigateToElement(elementId);
    },
    [navigateToElement],
  );

  const openStorylineEditor = useCallback(() => {
    if (!curNode) return;
    const initialIds =
      currentStorylineIds.length > 0
        ? currentStorylineIds
        : curNode.mainStorylineId
          ? [curNode.mainStorylineId]
          : [];
    setDraftStorylineIds(initialIds);
    setDraftMainStorylineId(
      initialIds.includes(curNode.mainStorylineId)
        ? curNode.mainStorylineId
        : initialIds[0] || null,
    );
    setEditingStorylines(true);
  }, [curNode, currentStorylineIds]);

  const handleToggleDraftStoryline = useCallback(
    (storylineId: string) => {
      setDraftStorylineIds((prev) => {
        if (prev.includes(storylineId)) {
          if (prev.length === 1) return prev;
          return prev.filter((id) => id !== storylineId);
        }

        return [...prev, storylineId];
      });
    },
    [],
  );

  const handleSelectDraftMainStoryline = useCallback((storylineId: string) => {
    setDraftStorylineIds((prev) => (prev.includes(storylineId) ? prev : [...prev, storylineId]));
    setDraftMainStorylineId(storylineId);
  }, []);

  const handleSaveStorylines = useCallback(async () => {
    if (!nodeId || !curNode || !draftMainStorylineId) return;

    const selectedIds = Array.from(new Set([draftMainStorylineId, ...draftStorylineIds]));
    try {
      if (draftMainStorylineId !== curNode.mainStorylineId) {
        await updateNode(nodeId, { mainStorylineId: draftMainStorylineId });
      }
      await setNodeStorylines(nodeId, selectedIds);
      setEditingStorylines(false);
    } catch (error) {
      log.error('[NodeEditor] Failed to update node storylines:', error);
      alert('Failed to update node storylines. Please try again.');
    }
  }, [
    curNode,
    draftMainStorylineId,
    draftStorylineIds,
    nodeId,
    setNodeStorylines,
    updateNode,
  ]);

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!nodeId || !curNode) return;

      if (action === 'threadPicker' || action === 'editNodeStorylines') {
        openStorylineEditor();
        return;
      }

      if (action === 'deleteNode') {
        const confirmed = window.confirm(`Delete node "${curNode.title}"?`);
        if (!confirmed) return;

        try {
          await deleteNode(nodeId);
          navigateToHome();
        } catch (error) {
          log.error('[NodeEditor] Failed to delete node:', error);
          alert('Failed to delete node. Please try again.');
        }
      }
    },
    [curNode, deleteNode, navigateToHome, nodeId, openStorylineEditor],
  );

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
            right={
              <>
                <span>{curNode.wordCount.toLocaleString()} 字</span>
                {currentStorylines.length > 1 && (
                  <>
                    <span className="editor-bar__sep">·</span>
                    <span>{currentStorylines.length} threads</span>
                  </>
                )}
              </>
            }
          >
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
                  <div className="crumb-dropdown__divider" />
                  <div className="crumb-dropdown__footer" onClick={openStorylineEditor}>
                    Edit node storylines…
                  </div>
                </>
              }
            >
              <span>{mainStoryline?.name ?? 'No storyline'}</span>
            </EditorCrumb>

            <EditorCrumb
              dropdown={
                sameStorylineNodes.length === 0 ? (
                  <div className="crumb-dropdown__empty">No chapters in this storyline</div>
                ) : (
                  sameStorylineNodes.map((n, idx) => {
                    const isActive = n.id === nodeId;
                    return (
                      <div
                        key={n.id}
                        className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                        onClick={() => {
                          if (!isActive) navigateToNode(n.id);
                        }}
                      >
                        <span className="crumb-dropdown__num">{toRoman(idx + 1)}</span>
                        <span>{n.title || 'Untitled'}</span>
                      </div>
                    );
                  })
                )
              }
            >
              <span className="editor-crumb-num">Chapter {chapterRoman}</span>
              <span className="editor-crumb-sep">·</span>
              <span className="editor-crumb-title">{curNode.title || 'Untitled'}</span>
            </EditorCrumb>
          </EditorTopBar>

          {/* Manuscript page */}
          <div className="page">
            <aside className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Chapter</span>
              <span className="page__folio-line page__folio-line--accent">{chapterRoman}</span>
              <span className="page__folio-line">· {curNode.wordCount.toLocaleString()} 字</span>
            </aside>

            {mainStoryline && (
              <div className="page__chapter-mark">— {mainStoryline.name} —</div>
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
              onElementClick={handleElementClick}
              showTitle={true}
              showSummary={true}
              showTags={true}
              editableTitle={true}
              editableSummary={true}
              autoFocus={true}
              minHeight="400px"
            />

            <div className="page__ornament" aria-hidden="true">⁂</div>
          </div>
        </>
      )}

      {editingStorylines && curNode && (
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
          onClick={() => setEditingStorylines(false)}
        >
          <div
            style={{
              width: 'min(520px, 100%)',
              maxHeight: '80vh',
              overflow: 'auto',
              background: '#fefdfb',
              border: '1px solid var(--accent-border, #e8dcc8)',
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
              <div style={{ fontSize: 18, fontWeight: 700, color: '#2a1a0a' }}>
                Edit Node Storylines
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: '#7a6a56' }}>{curNode.title}</div>
            </div>

            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {storylines.map((storyline) => {
                const selected = draftStorylineIds.includes(storyline.id);
                const isMain = draftMainStorylineId === storyline.id;
                return (
                  <div
                    key={storyline.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '24px 1fr auto',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: selected
                        ? `1px solid ${storyline.color || '#b89968'}66`
                        : '1px solid rgba(184, 153, 104, 0.18)',
                      background: selected ? `${storyline.color || '#b89968'}12` : '#fffaf2',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => handleToggleDraftStoryline(storyline.id)}
                      aria-label={`Include ${storyline.name}`}
                    />
                    <button
                      type="button"
                      onClick={() => handleToggleDraftStoryline(storyline.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        color: '#3c3025',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: storyline.color || '#b89968',
                          flex: '0 0 auto',
                        }}
                      />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 14,
                          fontWeight: selected ? 700 : 500,
                        }}
                      >
                        {storyline.name}
                      </span>
                    </button>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        color: selected ? '#5a4a3a' : '#a39787',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      <input
                        type="radio"
                        name="main-storyline"
                        checked={isMain}
                        disabled={!selected}
                        onChange={() => handleSelectDraftMainStoryline(storyline.id)}
                      />
                      Main
                    </label>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                padding: '14px 18px 18px',
                borderTop: '1px solid rgba(184, 153, 104, 0.18)',
              }}
            >
              <button
                type="button"
                onClick={() => setEditingStorylines(false)}
                style={{
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: '1px solid var(--accent-border, #e8dcc8)',
                  background: '#fefdfb',
                  color: '#5a4a3a',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!draftMainStorylineId || draftStorylineIds.length === 0}
                onClick={() => void handleSaveStorylines()}
                style={{
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background:
                    !draftMainStorylineId || draftStorylineIds.length === 0
                      ? '#d8d0c3'
                      : 'var(--accent, #b89968)',
                  color: '#fefdfb',
                  cursor:
                    !draftMainStorylineId || draftStorylineIds.length === 0
                      ? 'not-allowed'
                      : 'pointer',
                  fontWeight: 700,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
