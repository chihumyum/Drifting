import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useStorylineUsecases } from '../hooks/useStorylineUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book_node';
import { EditorContextMenu } from '../components/EditorContextMenu';
import { EditorMenuBar } from '../components/EditorMenuBar';
import { useAuthStore, getProjectId } from '../store/auth';
import { useAppStore } from '../store';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function StorylineEditorView() {
  const { storylineId } = useParams<{ storylineId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const { bookNodes } = useAppStore();
  const storylineUsecases = useStorylineUsecases();
  const nodeUsecases = useBookNodeUsecases();
  const [storyline, setStoryline] = useState<Storyline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [allStorylines, setAllStorylines] = useState<Storyline[]>([]);
  const [storylineNodes, setStorylineNodes] = useState<BookNode[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryValue, setSummaryValue] = useState('');
  const isContentLoadedRef = useRef(false);
  const loadedStorylineIdRef = useRef<string | null>(null);
  
  // Initialize TipTap editor for description (pmJson)
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
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      createDefaultSlashMenu(),
    ],
    content: getDefaultDoc(),
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none min-h-[200px]',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!isContentLoadedRef.current || !storylineId) {
        return;
      }
      
      const json = ed.getJSON();
      
      // Auto-save description (pmJson)
      void storylineUsecases.updateStoryline({
        id: storylineId,
        pmJson: json,
      });
    },
  });
  
  // Load storyline data and nodes
  useEffect(() => {
    async function loadStoryline() {
      if (!storylineId) {
        navigate('/editor');
        return;
      }
      
      try {
        setIsLoading(true);
        const projectId = getProjectId(user?.id);
        const [storylineData, storylines, nodeIds] = await Promise.all([
          storylineUsecases.getStorylineById(storylineId),
          storylineUsecases.getStorylinesByProject(projectId),
          storylineUsecases.getNodeIdsByStoryline(storylineId),
        ]);
        
        if (!storylineData) {
          console.error(`Storyline ${storylineId} not found`);
          navigate('/editor');
          return;
        }
        
        setStoryline(storylineData);
        setAllStorylines(storylines);
        setNameValue(storylineData.name);
        setSummaryValue(storylineData.summary || '');
        
        // Get full node data for these nodeIds
        const nodes = bookNodes.filter(n => nodeIds.includes(n.id));
        // Sort by node.start or node.order
        nodes.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
        setStorylineNodes(nodes);
      } catch (error) {
        console.error('Failed to load storyline:', error);
        navigate('/editor');
      } finally {
        setIsLoading(false);
      }
    }
    
    loadStoryline();
  }, [storylineId, storylineUsecases, navigate, user, bookNodes]);
  
  // Update editor content when storyline loads
  useEffect(() => {
    if (!editor || !storyline) return;
    
    // If we're loading a different storyline, reset the flag
    if (loadedStorylineIdRef.current !== storylineId) {
      isContentLoadedRef.current = false;
      loadedStorylineIdRef.current = null;
    }
    
    // Load the storyline description content
    try {
      const content = storyline.pmJson 
        ? (typeof storyline.pmJson === 'string' ? JSON.parse(storyline.pmJson as string) : storyline.pmJson)
        : getDefaultDoc();
      
      editor.commands.setContent(content);
      
      // Mark content as loaded
      isContentLoadedRef.current = true;
      loadedStorylineIdRef.current = storylineId || null;
    } catch (error) {
      console.error('Failed to parse storyline description content', error);
      editor.commands.setContent(getDefaultDoc());
      isContentLoadedRef.current = true;
      loadedStorylineIdRef.current = storylineId || null;
    }
  }, [editor, storyline, storylineId]);
  
  const handleSaveName = async () => {
    if (!storylineId || !nameValue.trim()) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      name: nameValue.trim(),
    });
    setEditingName(false);
    // Reload storyline to update state
    const updated = await storylineUsecases.getStorylineById(storylineId);
    if (updated) setStoryline(updated);
  };

  const handleSaveSummary = async () => {
    if (!storylineId) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      summary: summaryValue,
    });
    setEditingSummary(false);
    // Reload storyline to update state
    const updated = await storylineUsecases.getStorylineById(storylineId);
    if (updated) setStoryline(updated);
  };
  
  const handleContextAction = async (action: string) => {
    if (!storyline) return;
    
    if (action === 'deleteStoryline') {
      const otherStorylines = allStorylines.filter(t => t.id !== storyline.id);
      
      if (otherStorylines.length === 0) {
        alert('Cannot delete the last storyline. Create another storyline first.');
        return;
      }
      
      const confirmed = window.confirm(
        'Delete this storyline? All nodes will be moved to another storyline if available.'
      );
      
      if (!confirmed) return;
      
      try {
        const nodes = await nodeUsecases.loadNodes();
        const defaultStoryline = otherStorylines[0];
        
        for (const node of nodes) {
          const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
          
          if (nodeStorylines.some(t => t.id === storyline.id)) {
            if (nodeStorylines.length === 1) {
              await storylineUsecases.addNodeToStoryline(node.id, defaultStoryline.id);
            }
            await storylineUsecases.removeNodeFromStoryline(node.id, storyline.id);
          }
        }
        
        await storylineUsecases.deleteStoryline(storyline.id);
        navigate('/editor');
      } catch (error) {
        console.error('Failed to delete storyline:', error);
        alert('Failed to delete storyline. Please try again.');
      }
    }
  };
  
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#999',
      }}>
        Loading storyline...
      </div>
    );
  }
  
  if (!storyline) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        color: '#999',
      }}>
        Select a storyline to view
      </div>
    );
  }
  
  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column',
      height: '100%',
      position: 'relative',
    }}>
      {/* Header Section */}
      <div style={{
        padding: '60px 80px 24px 80px',
        borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
      }}>
        {/* Storyline Name */}
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Storyline color indicator */}
          <div style={{
            width: 6,
            height: 40,
            backgroundColor: storyline.color,
            borderRadius: 3,
            flexShrink: 0,
          }} />
          
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') {
                  setNameValue(storyline.name);
                  setEditingName(false);
                }
              }}
              onFocus={(e) => e.target.select()}
              autoFocus
              style={{
                flex: 1,
                fontSize: 32,
                fontWeight: 700,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                padding: '8px 0',
                color: 'rgba(0, 0, 0, 0.85)',
              }}
            />
          ) : (
            <h1
              onClick={() => setEditingName(true)}
              style={{
                flex: 1,
                fontSize: 32,
                fontWeight: 700,
                margin: 0,
                padding: '8px 0',
                cursor: 'pointer',
                color: 'rgba(0, 0, 0, 0.85)',
                transition: 'color 0.2s ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.6)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.85)';
              }}
            >
              {storyline.name || 'Untitled Storyline'}
            </h1>
          )}
        </div>

        {/* Storyline Description/Summary - Simple text */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', marginBottom: 4 }}>
            Summary
          </div>
          {editingSummary ? (
            <input
              type="text"
              value={summaryValue}
              onChange={e => setSummaryValue(e.target.value)}
              onBlur={handleSaveSummary}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveSummary();
                if (e.key === 'Escape') {
                  setSummaryValue(storyline.summary || '');
                  setEditingSummary(false);
                }
              }}
              autoFocus
              placeholder="Brief summary..."
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: 6,
                outline: 'none',
                padding: '8px 12px',
                color: 'rgba(0, 0, 0, 0.65)',
              }}
            />
          ) : (
            <div
              onClick={() => setEditingSummary(true)}
              style={{
                fontSize: 14,
                color: storyline.summary ? 'rgba(0, 0, 0, 0.65)' : 'rgba(0, 0, 0, 0.35)',
                padding: '8px 12px',
                cursor: 'pointer',
                borderRadius: 6,
                transition: 'background 0.2s ease',
                minHeight: 24,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {storyline.summary || 'Click to add summary...'}
            </div>
          )}
        </div>

        {/* Description - Rich text editor */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', marginBottom: 4 }}>
            Description
          </div>
          <div style={{
            border: '1px solid rgba(0, 0, 0, 0.1)',
            borderRadius: 6,
            padding: '12px',
            background: 'white',
            minHeight: 200,
          }}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>

      {/* Chapters Grid Section */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '32px 80px',
      }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{
            fontSize: 18,
            fontWeight: 600,
            color: 'rgba(0, 0, 0, 0.85)',
            margin: '0 0 16px 0',
          }}>
            Chapters in this Storyline ({storylineNodes.length})
          </h2>
        </div>

        {storylineNodes.length === 0 ? (
          <div style={{
            padding: '48px 24px',
            textAlign: 'center',
            color: 'rgba(0, 0, 0, 0.45)',
            fontSize: 14,
          }}>
            No chapters in this storyline yet. Add chapters from the timeline view.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}>
            {storylineNodes.map(node => (
              <div
                key={node.id}
                onClick={() => navigate(`/editor/${node.id}`)}
                style={{
                  padding: 16,
                  border: '1px solid rgba(0, 0, 0, 0.1)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  background: 'white',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = storyline.color;
                  e.currentTarget.style.boxShadow = `0 2px 8px ${storyline.color}20`;
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.1)';
                  e.currentTarget.style.boxShadow = 'none';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'rgba(0, 0, 0, 0.85)',
                  marginBottom: 8,
                }}>
                  {node.title || 'Untitled Chapter'}
                </div>
                {node.summary && (
                  <div style={{
                    fontSize: 14,
                    color: 'rgba(0, 0, 0, 0.55)',
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {node.summary}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Reserved space for future features */}
        <div style={{
          marginTop: 48,
          padding: '32px 24px',
          border: '2px dashed rgba(0, 0, 0, 0.1)',
          borderRadius: 8,
          textAlign: 'center',
          color: 'rgba(0, 0, 0, 0.35)',
          fontSize: 13,
        }}>
          More features coming soon...
        </div>
      </div>
      
      {/* Editor Menu Bar */}
      <EditorMenuBar editor={editor} />
      
      {/* Editor Context Menu */}
      <EditorContextMenu 
        editorType="storyline"
        onAction={handleContextAction}
      />
    </div>
  );
}
