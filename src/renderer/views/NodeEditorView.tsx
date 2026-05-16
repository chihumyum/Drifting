import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useStoryline } from '../usecase/useStoryline';
import { useBookContent } from '../usecase/useBookContent';
import { BookNode } from '../domain/book-node';
import type { Storyline } from '../domain/storyline';
import { ChapterEditor, type ChapterEditorRef } from '../components/editor/ChapterEditor';
import { EditorContextMenu } from '../components/editor/EditorContextMenu';
import loglevel from 'loglevel';
import { useDataStore } from '../store/data-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';

const log = loglevel.getLogger('NodeEditorView');
log.setLevel(loglevel.levels.ERROR);
// log.setLevel(loglevel.levels.DEBUG);

export function NodeEditorView() {
  // stuff for geting a node
  const navigate = useNavigate();
  const { navigateToElement, navigateToHome } = useProjectNavigation();
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
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  // this component only render one node
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  const [isContentLoaded, setIsContentLoaded] = useState(false);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [editingStorylines, setEditingStorylines] = useState(false);
  const [draftStorylineIds, setDraftStorylineIds] = useState<string[]>([]);
  const [draftMainStorylineId, setDraftMainStorylineId] = useState<string | null>(null);
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
      try {
        await renameNode(targetNodeId, title);
      } catch (error) {
        log.error('[NodeEditor] Failed to update title:', error);
      }
    },
    [renameNode],
  );

  const handleSummaryUpdate = useCallback(
    async (targetNodeId: string, summary: string) => {
      try {
        await updateNodeSummary(targetNodeId, summary);
      } catch (error) {
        log.error('[NodeEditor] Failed to update summary:', error);
      }
    },
    [updateNodeSummary],
  );

  const handleContentUpdate = useCallback(
    async (targetNodeId: string, pmJson: string, outlineJson: string) => {
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
          return;
        }

        const created = await createContent(targetNodeId, { contentJson: pmJson, outlineJson });
        if (activeNodeIdRef.current === targetNodeId) {
          setBookContent(created);
        }
      } catch (error) {
        log.error('[NodeEditor] Failed to update content:', error);
      }
    },
    [createContent, getContentByNodeId, updateContentByNodeId],
  );

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

  const renderStorylineBadge = (storyline: Storyline, isMain: boolean) => (
    <button
      key={storyline.id}
      type="button"
      onClick={openStorylineEditor}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 28,
        padding: '5px 9px',
        borderRadius: 6,
        border: `1px solid ${storyline.color || '#b89968'}55`,
        background: isMain ? `${storyline.color || '#b89968'}1f` : '#fffaf2',
        color: '#4b3f32',
        fontSize: 12,
        fontWeight: isMain ? 700 : 500,
        cursor: 'pointer',
      }}
      title={isMain ? 'Main storyline' : 'Storyline'}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: storyline.color || '#b89968',
          flex: '0 0 auto',
        }}
      />
      <span>{storyline.name}</span>
      {isMain && <span style={{ color: '#7a6a56', fontWeight: 600 }}>Main</span>}
    </button>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      <EditorContextMenu editorType="node" onAction={handleContextAction} />

      {/* Main Editor Container */}
      <div
        className="main-editor"
        style={
          {
            // flex: 1,
            // overflow: 'auto',
          }
        }
      >
        <div
          style={{
            maxWidth: '960px',
            margin: '0 auto',
            width: '100%',
          }}
        >
          <div
            style={{
              background: '#fefdfb',
              borderRadius: 12,
              boxShadow: '0 2px 8px rgba(139, 115, 85, 0.12)',
              padding: '32px 38px',
              minHeight: 'calc(100vh - 300px)',
              position: 'relative',
            }}
          >
            {isActiveNodeReady && nodeId && curNode && (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    marginBottom: 20,
                    paddingBottom: 14,
                    borderBottom: '1px solid rgba(184, 153, 104, 0.18)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        color: '#7a6a56',
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Storylines
                    </span>
                    {currentStorylines.length > 0 ? (
                      currentStorylines.map((storyline) =>
                        renderStorylineBadge(storyline, storyline.id === mainStoryline?.id),
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={openStorylineEditor}
                        style={{
                          padding: '5px 9px',
                          borderRadius: 6,
                          border: '1px solid var(--accent-border, #e8dcc8)',
                          background: '#fffaf2',
                          color: '#7a6a56',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        No storyline
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={openStorylineEditor}
                    style={{
                      padding: '7px 11px',
                      borderRadius: 6,
                      border: '1px solid var(--accent-border, #e8dcc8)',
                      background: '#fefdfb',
                      color: '#5a4a3a',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      flex: '0 0 auto',
                    }}
                  >
                    Edit
                  </button>
                </div>

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
              </>
            )}
          </div>
        </div>
      </div>

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
