import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useStoryThreadUsecases } from '../hooks/useStoryThreadUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import type { StoryThread } from '../domain/story_thread';
import { BackButton } from '../components/BackButton';
import { EditorContextMenu } from '../components/EditorContextMenu';
import { EditorMenuBar } from '../components/EditorMenuBar';
import { useAuthStore, getProjectId } from '../store/auth';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function ThreadEditorView() {
  const { threadId } = useParams<{ threadId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const threadUsecases = useStoryThreadUsecases();
  const nodeUsecases = useBookNodeUsecases();
  const [thread, setThread] = useState<StoryThread | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [allThreads, setAllThreads] = useState<StoryThread[]>([]);
  const saveTimeoutRef = useRef<number | null>(null);
  const isContentLoadedRef = useRef(false);
  const loadedThreadIdRef = useRef<string | null>(null);
  
  // Load thread data
  useEffect(() => {
    async function loadThread() {
      if (!threadId) {
        navigate('/editor');
        return;
      }
      
      try {
        setIsLoading(true);
        const projectId = getProjectId(user?.id);
        console.log('[ThreadEditorView] Loading thread:', threadId, 'projectId:', projectId, 'userId:', user?.id);
        const [threadData, threads] = await Promise.all([
          threadUsecases.getThreadById(threadId),
          threadUsecases.getThreadsByProject(projectId),
        ]);
        
        console.log('[ThreadEditorView] Thread data:', threadData);
        console.log('[ThreadEditorView] All threads:', threads.length);
        
        if (!threadData) {
          console.error(`Thread ${threadId} not found`);
          navigate('/editor');
          return;
        }
        
        setThread(threadData);
        setAllThreads(threads);
      } catch (error) {
        console.error('Failed to load thread:', error);
        navigate('/editor');
      } finally {
        setIsLoading(false);
      }
    }
    
    loadThread();
  }, [threadId, threadUsecases, navigate, user]);
  
  // Initialize TipTap editor
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
    autofocus: 'end',
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
      
      // Auto-save after 1 second of inactivity
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      
      saveTimeoutRef.current = window.setTimeout(() => {
        handleSave(ed.getJSON());
      }, 1000);
    },
  });
  
  // Update editor content when thread loads
  useEffect(() => {
    if (!editor || !thread || editor.isDestroyed) return;
    
    // If we're loading a different thread, reset the flag
    if (loadedThreadIdRef.current !== threadId) {
      isContentLoadedRef.current = false;
      loadedThreadIdRef.current = null;
    }
    
    // Load the thread content
    try {
      const content = thread.pmJson 
        ? (typeof thread.pmJson === 'string' ? JSON.parse(thread.pmJson) : thread.pmJson)
        : getDefaultDoc();
      
      editor.commands.setContent(content);
      
      // Mark content as loaded
      isContentLoadedRef.current = true;
      loadedThreadIdRef.current = threadId || null;
    } catch (error) {
      console.error('Failed to parse thread content', error);
      editor.commands.setContent(getDefaultDoc());
      isContentLoadedRef.current = true;
      loadedThreadIdRef.current = threadId || null;
    }
  }, [editor, thread, threadId]);
  
  const handleSave = async (content: object) => {
    if (!threadId) return;
    
    try {
      await threadUsecases.updateThread({
        id: threadId,
        pmJson: content,
      });
    } catch (error) {
      console.error('Failed to save thread:', error);
    }
  };
  
  // Cleanup
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (editor && !editor.isDestroyed) {
        editor.destroy();
      }
    };
  }, [editor]);
  
  const handleContextAction = async (action: string) => {
    if (!thread) return;
    
    if (action === 'deleteThread') {
      const otherThreads = allThreads.filter(t => t.id !== thread.id);
      
      if (otherThreads.length === 0) {
        alert('Cannot delete the last thread. Create another thread first.');
        return;
      }
      
      const confirmed = window.confirm(
        'Delete this thread? All nodes will be moved to another thread if available.'
      );
      
      if (!confirmed) return;
      
      try {
        // Get all nodes
        const nodes = await nodeUsecases.loadNodes();
        const defaultThread = otherThreads[0];
        
        // Process each node
        for (const node of nodes) {
          const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
          
          if (nodeThreads.some(t => t.id === thread.id)) {
            if (nodeThreads.length === 1) {
              // Node only belongs to this thread - move to default
              await threadUsecases.addNodeToThread(node.id, defaultThread.id);
            }
            // Remove from current thread
            await threadUsecases.removeNodeFromThread(node.id, thread.id);
          }
        }
        
        // Delete thread
        await threadUsecases.deleteThread(thread.id);
        
        // Navigate back
        navigate('/editor');
      } catch (error) {
        console.error('Failed to delete thread:', error);
        alert('Failed to delete thread. Please try again.');
      }
    } else if (action === 'mergeThread') {
      const otherThreads = allThreads.filter(t => t.id !== thread.id);
      
      if (otherThreads.length === 0) {
        alert('No other threads available to merge into.');
        return;
      }
      
      // Show thread selector
      const targetThreadName = prompt(
        `Merge "${thread.name}" into which thread?\n\n` +
        `Available threads:\n${otherThreads.map((t, i) => `${i + 1}. ${t.name}`).join('\n')}\n\n` +
        `Enter the number:`
      );
      
      if (!targetThreadName) return;
      
      const index = parseInt(targetThreadName) - 1;
      if (isNaN(index) || index < 0 || index >= otherThreads.length) {
        alert('Invalid selection.');
        return;
      }
      
      const targetThread = otherThreads[index];
      
      try {
        // Get all nodes
        const nodes = await nodeUsecases.loadNodes();
        
        for (const node of nodes) {
          const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
          
          if (nodeThreads.some(t => t.id === thread.id)) {
            // Add to target thread if not already there
            if (!nodeThreads.some(t => t.id === targetThread.id)) {
              await threadUsecases.addNodeToThread(node.id, targetThread.id);
            }
            // Remove from current thread
            await threadUsecases.removeNodeFromThread(node.id, thread.id);
          }
        }
        
        // Delete current thread
        await threadUsecases.deleteThread(thread.id);
        
        // Navigate to target thread
        navigate(`/editor/thread/${targetThread.id}`);
      } catch (error) {
        console.error('Failed to merge thread:', error);
        alert('Failed to merge thread. Please try again.');
      }
    }
  };
  
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'rgba(71, 71, 71, 0.5)',
      }}>
        Loading thread...
      </div>
    );
  }
  
  if (!thread) {
    return null;
  }
  
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#fefdfb',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 24px',
        borderBottom: '1px solid var(--accent-border, #e8dcc8)',
        background: 'linear-gradient(to bottom, #fefdfb, #f9f6f1)',
      }}>
        <BackButton />
        
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flex: 1,
        }}>
          {/* Thread color indicator */}
          <div style={{
            width: 4,
            height: 32,
            backgroundColor: thread.color,
            borderRadius: 2,
          }} />
          
          {/* Thread name */}
          <div>
            <div style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'rgba(71, 71, 71, 0.9)',
            }}>
              {thread.name}
            </div>
            {thread.summary && (
              <div style={{
                fontSize: 13,
                color: 'rgba(71, 71, 71, 0.5)',
                marginTop: 2,
              }}>
                {thread.summary}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Editor */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '40px 80px',
      }}>
        <div style={{
          maxWidth: 800,
          margin: '0 auto',
        }}>
          <EditorContent editor={editor} />
        </div>
      </div>
      
      {/* Editor Menu Bar */}
      <EditorMenuBar editor={editor} />
      
      {/* Context Menu */}
      <EditorContextMenu 
        editorType="thread"
        onAction={handleContextAction}
      />
    </div>
  );
}
