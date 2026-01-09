import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import type { BookNode } from '../domain/book-node';
import { ChapterEditor, type ChapterEditorRef } from '../viewComponents/editor/ChapterEditor';
import log from "loglevel";
import { Loader2 } from 'lucide-react';
import { useDataStore } from '../store/data-store';
import { NodeContent } from '../domain/node-content';
import { NodeTag } from '../domain/node-tag';

log.setLevel(log.levels.ERROR);

export function NodeEditorView() {
  // stuff for geting a node
  const navigate = useNavigate();
  const { nodeId } = useParams<{ nodeId: string }>();
  const { bookNodes } = useDataStore();
  // this component only render one node
  const [curNode, setCurNode] = useState<Partial<BookNode> | null>(null);
  const [currentContent, setCurrentContent] = useState<null | NodeContent>(null);
  const [curTags, setCurTags] = useState<NodeTag[]>([]);
  // other usecases
  const { renameNode, updateNodeSummary, loadNodes } = useBookNodeUsecases();
  const editorRef = useRef<ChapterEditorRef>(null);
  // Loading state to prevent rendering editor with empty content during fetch
  const [isLoading, setIsLoading] = useState(false);




  const handleElementClick = useCallback(
    (elementId: string) => {
      navigate(`/element/${elementId}`);
    },
    [navigate]
  );

  const handleContentUpdate = useCallback(
    async (targetNodeId: string, pmJson: string, outlineJson: string) => {
      try {

        // Safety Check 1: Ensure we have content in store - we don't need the content
        if (!currentContent) {
          log.warn('[NodeEditor] Store content is null, cannot update. Node:', targetNodeId);
          return;
        }

        // Safety Check 2: Critical! Ensure we are updating the correct node.
        if (currentContent.nodeId !== targetNodeId) {
          log.warn(
            '[NodeEditor] ID Mismatch during update. Store:',
            currentContent.nodeId,
            'Target:',
            targetNodeId,
            ' - Aborting save.'
          );
          return;
        }

        // log.info('Updating existing content for node', targetNodeId);
        await updateContent({
          id: currentContent.id,
          nodeId: targetNodeId,
          pmJson,
          outlineJson,
        });
      } catch (error) {
        log.error('[NodeEditor] Failed to update content:', error);
      }
    },
    [updateContent]
  );

  // 标题更新处理
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

  // 摘要更新处理
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

  // Load nodes on mount if not already loaded
  useEffect(() => {
    if (bookNodes.length === 0) {
      void loadNodes();
    }
  }, [bookNodes.length, loadNodes]);

  // get nodeId from url and update current node
  useEffect(() => {
    if (!nodeId) {
      navigate('/', { replace: true });
      return;
    }

    setSelectedNodeId(nodeId);
    const node = bookNodes.find(n => n.id === nodeId) || null;
    setCurNode(node);
  }, [bookNodes, nodeId, navigate, setSelectedNodeId]);

  // load content when nodeId changes
  useEffect(() => {
    if (!nodeId) return;

    let isMounted = true;

    const fetchContent = async () => {
      setIsLoading(true);
      try {
        await loadContent(nodeId);

        if (!isMounted) return;

        // Check store for loaded content
        const state = useAppStore.getState();
        const loadedContent = state.bookContent;

        // If no content exists for this node, ONLY THEN initialize new content
        if (!loadedContent || loadedContent.nodeId !== nodeId) {
          log.info('[NodeEditor] No existing content found for node', nodeId, '- initializing new content');
          const defaultDocJson = JSON.stringify({
            type: 'doc',
            content: [],
          });
          await newContent(nodeId, defaultDocJson);
        }
      } catch (error) {
        log.error('[NodeEditor] Failed to load/create chapter content', error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void fetchContent();

    return () => {
      isMounted = false;
    };
  }, [loadContent, newContent, nodeId]);

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
