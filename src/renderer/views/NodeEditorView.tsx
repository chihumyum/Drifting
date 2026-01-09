import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNode } from '../usecase/useBookNode';
import { useBookContent } from '../usecase/useBookContent';
import type { BookNode } from '../domain/book-node';
import { ChapterEditor, type ChapterEditorRef } from '../viewComponents/editor/ChapterEditor';
import log from "loglevel";
import { Loader2 } from 'lucide-react';
import { useDataStore } from '../store/data-store';
import { NodeContent } from '../domain/node-content';

log.setLevel(log.levels.ERROR);

export function NodeEditorView() {
  // stuff for geting a node
  const navigate = useNavigate();
  const { nodeId } = useParams<{ nodeId: string }>();
  const { bookNodes } = useDataStore();
  // this component only render one node
  const [curNode, setCurNode] = useState<Partial<BookNode> | null>(null);
  const [bookContent, setBookContent] = useState<NodeContent | null>(null);
  // usecases
  const { renameNode, updateNodeSummary, loadNodes } = useBookNode();
  const { getContentById, getContentByNodeId, updateContent, createContent } = useBookContent();
  // for focus at this level
  const editorRef = useRef<ChapterEditorRef>(null);
  // Loading state to prevent rendering editor with empty content during fetch
  const [isLoading, setIsLoading] = useState(false);

  // get nodeId from url params
  useEffect(() => {
    if (!nodeId) {
      navigate('/', { replace: true });
      return;
    }

    const node = bookNodes.find(n => n.id === nodeId) || null;
    setCurNode(node);
  }, [bookNodes, nodeId, navigate]);

  // load content when node changes
  useEffect(() => {
    if (!nodeId) {
      log.error('[NodeEditor] No nodeId provided in URL params');
      return;
    }

    const fetchContent = async () => {
      setIsLoading(true);
      try {
        const cont = await getContentByNodeId(nodeId);
        if (!cont) {
          log.error('[NodeEditor] No content found for nodeId', nodeId);
        }
        setBookContent(cont);
      } catch (error) {
        log.error('[NodeEditor] Failed to load/create chapter content', error);
      }
    };

    void fetchContent();
  }, [nodeId, getContentById]);


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
    async (targetNodeId: string, summary: string | null) => {
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
            return {...prev, pmJson, outlineJson};
          }
          return prev;
        });
        updateContent({ nodeId: targetNodeId, pmJson, outlineJson });
      } catch (error) {
        log.error('[NodeEditor] Failed to update content:', error);
      }
    },
    [updateContent]
  );

  const handleElementClick = useCallback(
    (elementId: string) => {
      navigate(`/element/${elementId}`);
    },
    [navigate]
  );

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#fefdfb',
        overflow: 'hidden',
      }}
    >
      {/* Main Editor Container */}
      <div
        data-editor-scroll
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '72px 56px 32px 56px',
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
            {isLoading ? (
              <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '400px',
                color: '#b89968'
              }}>
                <Loader2 className="animate-spin" size={32} />
              </div>
            ) : (
              nodeId && bookContent && bookContent.nodeId === nodeId && curNode && (
                <ChapterEditor
                  ref={editorRef}
                  nodeId={nodeId}
                  content={bookContent.pmJson}
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
