import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { createDefaultSlashMenu } from '@chi-hum/tiptap-simple-slash-menu';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../../store';
import { useBookContentUsecases } from '../../hooks/useBookContentUsecases';
import { useBookNodeUsecases } from '../../hooks/useBookNodeUsecases';
import { useNodeTagUsecases } from '../../hooks/useNodeTagUsecases';
import type { BookNode } from '../../domain/book_node';
import type { NodeTag } from '../../domain/story_stage';
import { EditorMenuBar } from './EditorMenuBar';
import { RightVerticalButtons } from '../../components/RightVerticalButtons';
import { TitleSummaryBubble } from '../../components/TitleSummaryBubble';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function EditorView() {
  const navigate = useNavigate();
  const { nodeId } = useParams<{ nodeId: string }>();
  const {
    setSelectedNodeId,
    bookContent,
    bookNodes,
  } = useAppStore();

  const { loadContent, updateContent, newContent } = useBookContentUsecases();
  const { renameNode, updateNodeSummary, loadNodes } = useBookNodeUsecases();
  const { getTagsForNode } = useNodeTagUsecases();
  const [curNode, setCurNode] = useState<Partial<BookNode> | null>(null);
  const [nodeTags, setNodeTags] = useState<NodeTag[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [summaryValue, setSummaryValue] = useState('');

  const isContentLoadedRef = useRef(false);
  const loadedNodeIdRef = useRef<string | null>(null);

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
    setTitleValue(node?.title || '');
    setSummaryValue(node?.summary || '');
    
    // Load tags for this node
    if (nodeId) {
      getTagsForNode(nodeId).then(tags => {
        setNodeTags(tags);
      }).catch(error => {
        console.error('Failed to load tags for node:', error);
        setNodeTags([]);
      });
    }
  }, [bookNodes, nodeId, navigate, setSelectedNodeId, getTagsForNode]);


  // load content when nodeId changes
  useEffect(() => {
    if (!nodeId) return;

    // Reset flag when switching nodes
    isContentLoadedRef.current = false;
    loadedNodeIdRef.current = null;
    
    void (async () => {
      try {
        await loadContent(nodeId);
        
        // Check if content was actually loaded
        const loadedContent = useAppStore.getState().bookContent;
        if (!loadedContent || loadedContent.nodeId !== nodeId) {
          // Content not found - create a new one
          console.warn('No content found for node', nodeId, '- creating new content');
          const defaultDocJson = JSON.stringify({
            type: 'doc',
            content: [],
          });
          await newContent(nodeId, defaultDocJson);
        }
        
        // Mark content as loaded after successful load
        isContentLoadedRef.current = true;
        loadedNodeIdRef.current = nodeId;
      } catch (error) {
        console.error('Failed to load chapter content', error);
        isContentLoadedRef.current = true; // Still mark as loaded to allow editing
        loadedNodeIdRef.current = nodeId;
      }
    })();
  }, [loadContent, newContent, nodeId]);


  // Tiptap editor setup
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      createDefaultSlashMenu(),
    ],
    content: getDefaultDoc(),
    autofocus: 'end', // Focus at the end instead of selecting all
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none min-h-[400px]',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      // Don't save until initial content is loaded
      if (!isContentLoadedRef.current) {
        console.log('Skipping save: content not yet loaded');
        return;
      }
      
      const json = ed.getJSON();
      const pmJson = JSON.stringify(json);
      if (pmJson === bookContent?.pmJson) return;
      
      // If content exists, update it
      if (bookContent && bookContent.id) {
        void updateContent({
          id: bookContent.id,
          nodeId: bookContent.nodeId,
          pmJson,
        });
      } else if (nodeId) {
        // Content doesn't exist - create it (fallback safety)
        console.warn('No content found during save for node', nodeId, '- creating new content');
        void newContent(nodeId, pmJson);
      }
    },
  });

  // initial load, set book content into editor ONLY when nodeId changes
  useEffect(() => {
    if (!editor) {
      console.log('Editor not ready yet');
      return;
    }
    if (!nodeId) {
      console.log('No nodeId provided');
      return;
    }
    
    // Only set content if we haven't loaded this nodeId yet
    if (loadedNodeIdRef.current === nodeId) {
      console.log('Content already loaded for this nodeId, skipping setContent');
      return;
    }
    
    if (bookContent && bookContent.nodeId !== nodeId) {
      console.log('Book content nodeId does not match current nodeId');
      return;
    }
    
    if (bookContent) {
      try {
        const doc = JSON.parse(bookContent.pmJson) as JSONContent;
        editor.commands.setContent(doc);
        // Clear selection and move cursor to end to avoid selecting all content
        editor.commands.focus('end');
        editor.commands.setTextSelection(editor.state.doc.content.size);
        console.log('Set editor content from book content');
      } catch (error) {
        console.error('Failed to parse editor content; falling back to default doc', error);
        editor.commands.setContent(getDefaultDoc());
        editor.commands.focus('end');
      }
    } else { // only set default doc when book content is null
      console.log('No content found, setting to default doc');
      editor.commands.setContent(getDefaultDoc());
      editor.commands.focus('end');
    }
    
    // Mark content as fully loaded after setting it in the editor
    // Use a small delay to ensure the editor has processed the content
    setTimeout(() => {
      isContentLoadedRef.current = true;
      loadedNodeIdRef.current = nodeId;
    }, 0);
  }, [bookContent, editor, nodeId]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#fdfcfe',
        overflow: 'hidden',
      }}
    >
      {/* Title Bubble Group */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 24,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          zIndex: 10,
        }}
      >
        {/* Title/Summary Bubble */}
        <TitleSummaryBubble 
          title={titleValue} 
          summary={summaryValue} 
        />
      </div>

      {/* Main Editor Container - Everything scrolls together */}
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
        {/* Title and Summary Header */}
        <div 
          data-title-header
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'flex-start',
            gap: '24px',
            marginBottom: '20px',
          }}
        >
          {/* Title - Left */}
          <div style={{ flex: 1 }}>
            {editingTitle ? (
              <input
                type="text"
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false);
                  if (curNode?.id && titleValue.trim() && titleValue !== curNode.title) {
                    void renameNode(curNode.id, titleValue.trim());
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    setTitleValue(curNode?.title || '');
                    setEditingTitle(false);
                  }
                }}
                autoFocus
                style={{
                  width: '100%',
                  fontSize: 28,
                  fontWeight: 700,
                  color: '#1a1625',
                  border: '2px solid #8b7fa8',
                  borderRadius: 8,
                  padding: '8px 12px',
                  outline: 'none',
                  background: '#fff',
                }}
              />
            ) : (
              <div
                onClick={() => setEditingTitle(true)}
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: '#1a1625',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  borderRadius: 8,
                  transition: 'background 0.15s ease',
                  minHeight: 48,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(139, 127, 168, 0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                {titleValue}
              </div>
            )}
          </div>

          {/* Summary and Tags - Right */}
          <div style={{ 
            flex: 1, 
            display: 'flex', 
            gap: '16px',
            alignItems: 'flex-start',
          }}>
            {/* Summary */}
            <div style={{ flex: 1 }}>
              {editingSummary ? (
                <textarea
                  value={summaryValue}
                  onChange={(e) => setSummaryValue(e.target.value)}
                  onBlur={() => {
                    setEditingSummary(false);
                    if (curNode?.id && summaryValue !== (curNode.summary || '')) {
                      void updateNodeSummary(curNode.id, summaryValue.trim() || null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSummaryValue(curNode?.summary || '');
                      setEditingSummary(false);
                    }
                  }}
                  autoFocus
                  style={{
                    width: '100%',
                    minHeight: 80,
                    fontSize: 14,
                    fontWeight: 400,
                    color: '#4a4358',
                    border: '2px solid #8b7fa8',
                    borderRadius: 8,
                    padding: '8px 12px',
                    outline: 'none',
                    background: '#fff',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
              ) : (
                <div
                  onClick={() => setEditingSummary(true)}
                  style={{
                    fontSize: 14,
                    fontWeight: 400,
                    color: '#4a4358',
                    cursor: 'pointer',
                    padding: '8px 12px',
                    borderRadius: 8,
                    transition: 'background 0.15s ease',
                    minHeight: 48,
                    lineHeight: 1.6,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(139, 127, 168, 0.08)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {summaryValue}
                </div>
              )}
            </div>

            {/* Tags */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
              alignItems: 'flex-start',
              minWidth: '200px',
              padding: '8px 12px',
            }}>
              {nodeTags.length > 0 ? (
                nodeTags.map(tag => (
                  <span
                    key={tag.id}
                    style={{
                      display: 'inline-block',
                      padding: '4px 12px',
                      borderRadius: '16px',
                      fontSize: '12px',
                      fontWeight: 500,
                      backgroundColor: tag.color || '#E5E7EB',
                      color: '#1F2937',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              ) : (
                <span style={{
                  fontSize: '12px',
                  color: '#9CA3AF',
                  fontStyle: 'italic',
                }}>
                  无标签
                </span>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 20,
            background: '#ffffff',
            borderRadius: 12,
            boxShadow: '0 2px 8px rgba(31, 26, 58, 0.08)',
            padding: '32px 38px',
            minHeight: 'calc(100vh - 300px)',
          }}
        >
          <EditorContent
            editor={editor}
          />
        </div>
        </div>
      </div>

      {/* Menu Bar - Fixed at top right */}
      <EditorMenuBar editor={editor} />
      
      {/* Right Vertical Utility Buttons */}
      <RightVerticalButtons />
    </div>
  );
}
