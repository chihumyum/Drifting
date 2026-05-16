import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import { BookNode } from '../domain/book-node';
import { ChapterEditor, type ChapterEditorRef } from '../components/editor/ChapterEditor';
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
  const { navigateToElement } = useProjectNavigation();
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
  const { bookNodes } = useDataStore();
  // this component only render one node
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  const [isContentLoaded, setIsContentLoaded] = useState(false);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  // usecases
  const { renameNode, updateNodeSummary } = useBookNode({
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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
      }}
    >
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
