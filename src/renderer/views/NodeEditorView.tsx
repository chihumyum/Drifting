import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import { BookNode } from '../domain/book-node';
import { ChapterEditor, type ChapterEditorRef } from '../viewComponents/editor/ChapterEditor';
import loglevel from "loglevel";
import { useDataStore } from '../store/data-store';
import { NodeContent } from '../domain/node-content';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';

const log = loglevel.getLogger("NodeEditorView");
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
  const { bookNodes } = useDataStore();
  // this component only render one node
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  // usecases
  const { renameNode, updateNodeSummary } = useBookNode({
    projectId: projectId,
    userId: userId,
  });
  const { getContentByNodeId, updateContentByNodeId } = useBookContent({
    userId: userId,
  });
  // for focus at this level
  const editorRef = useRef<ChapterEditorRef>(null);

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

    return bookNodes.find(n => n.id === nodeId) || null;
  }, [bookNodes, nodeId]);

  // load content when node changes
  useEffect(() => {
    if (!nodeId) {
      log.error('[NodeEditor] No nodeId provided in URL params');
      return;
    }

    const fetchContent = async () => {
      try {
        log.debug('[NodeEditor] Fetching content for nodeId', nodeId);
        const cont = await getContentByNodeId(nodeId);
        log.debug('[NodeEditor] Fetched content:', cont);
        if (!cont) {
          log.error('[NodeEditor] No content found for nodeId', nodeId);
        }
        setBookContent(cont);
      } catch (error) {
        log.error('[NodeEditor] Failed to load/create chapter content', error);
      }
    };

    void fetchContent();
  }, [nodeId, getContentByNodeId]);


  const handleTitleUpdate = useCallback(
    async (targetNodeId: string, title: string) => {
      try {
        await renameNode(targetNodeId, title);
      } catch (error) {
        log.error('[NodeEditor] Failed to update title:', error);
      }
    },
    [renameNode]
  );

  const handleSummaryUpdate = useCallback(
    async (targetNodeId: string, summary: string) => {
      try {
        await updateNodeSummary(targetNodeId, summary);
      } catch (error) {
        log.error('[NodeEditor] Failed to update summary:', error);
      }
    },
    [updateNodeSummary]
  );

  const handleContentUpdate = useCallback(
    async (targetNodeId: string, pmJson: string, outlineJson: string) => {
      try {
        // Check if content exists
        setBookContent((prev) => {
          if (prev && prev.nodeId === targetNodeId) {
            return {...prev, contentJson: pmJson, outlineJson};
          }
          return prev;
        });
        updateContentByNodeId(targetNodeId, { contentJson: pmJson, outlineJson });
      } catch (error) {
        log.error('[NodeEditor] Failed to update content:', error);
      }
    },
    [updateContentByNodeId]
  );

  const handleElementClick = useCallback(
    (elementId: string) => {
      navigateToElement(elementId);
    },
    [navigateToElement]
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
      className='main-editor'
        style={{
          // flex: 1,
          // overflow: 'auto',
        }}
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
            {nodeId && bookContent && bookContent.nodeId === nodeId && curNode && (
                <ChapterEditor
                  ref={editorRef}
                  nodeId={nodeId}
                  projectId={projectId}
                  content={bookContent.contentJson}
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
              )
            }
          </div>
        </div>
      </div>
    </div>
  );
}
