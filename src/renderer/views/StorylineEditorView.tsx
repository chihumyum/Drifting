import { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useStoryline } from '../usecase/useStoryline';
import { EditorContextMenu } from '../viewComponents/editor/EditorContextMenu';
import { useAuthStore, getProjectId } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { StorylineAllChapterEditor } from '../viewComponents/editor/StorylineAllChapterEditor';
import log from "loglevel";

log.setLevel(log.levels.ERROR);
const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [],
});

function getDefaultDoc(): JSONContent {
  return JSON.parse(DEFAULT_DOC_STRING) as JSONContent;
}

export function StorylineEditorView() {
  const { projectId, storylineId } = useParams<{ projectId: string; storylineId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const { bookNodes, storylines, storylineNodeMapping } = useDataStore();
  const storylineUsecases = useStoryline();
  
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const isContentLoadedRef = useRef(false);
  const loadedStorylineIdRef = useRef<string | null>(null);

  const activeStoryline = storylines.find(s => s.id === storylineId);
  const activeStorylineNodeIds = storylineNodeMapping[storylineId || ''] || [];
  
  const storylineNodes = useMemo(() => {
    if (!storylineId) return [];
    return bookNodes
      .filter(n => activeStorylineNodeIds.includes(n.id))
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }, [bookNodes, activeStorylineNodeIds, storylineId]);

  useEffect(() => {
    async function checkData() {
      if (!projectId || !storylineId) {
        log.error('No projectId or storylineId provided in URL');
        navigate('/editor');
        return;
      }
      
      
      if (projectId && (!storylineNodeMapping[storylineId] || storylineNodeMapping[storylineId].length === 0)) {
         void storylineUsecases.getNodeIdsByStoryline(storylineId);
      }
    }
    checkData();
  }, [projectId, storylineId, user, storylineUsecases, navigate, storylineNodeMapping]);

  useEffect(() => {
    if (activeStoryline) {
      setNameValue(activeStoryline.name);
    }
  }, [activeStoryline]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
        underline: false,
        link: false, // 禁用 StarterKit 自带的 link，使用自定义配置
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      Placeholder.configure({
        placeholder: 'Add a summary for this storyline...',
      }),
      createDefaultSlashMenu(),
    ],
    content: getDefaultDoc(),
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!isContentLoadedRef.current || !storylineId) {
        return;
      }

      const json = ed.getJSON();

      void storylineUsecases.updateStoryline({
        id: storylineId,
        pmJson: json,
      });
    },
  });

  // Update editor content when storyline loads
  useEffect(() => {
    if (!editor || !activeStoryline) return;

    if (loadedStorylineIdRef.current !== storylineId) {
      isContentLoadedRef.current = false;
      loadedStorylineIdRef.current = null;
    }
    
    if (loadedStorylineIdRef.current === storylineId && isContentLoadedRef.current) {
        return;
    }

    try {
      const content = activeStoryline.pmJson
        ? (typeof activeStoryline.pmJson === 'string' ? JSON.parse(activeStoryline.pmJson as string) : activeStoryline.pmJson)
        : getDefaultDoc();

      editor.commands.setContent(content);

      isContentLoadedRef.current = true;
      loadedStorylineIdRef.current = storylineId || null;
    } catch (error) {
      log.error('Failed to parse storyline description content', error);
      editor.commands.setContent(getDefaultDoc());
      isContentLoadedRef.current = true;
      loadedStorylineIdRef.current = storylineId || null;
    }
  }, [editor, activeStoryline, storylineId]);

  const handleSaveName = async () => {
    if (!storylineId || !nameValue.trim()) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      name: nameValue.trim(),
    });
    setEditingName(false);
  };


  const handleContextAction = async (action: string) => {
    if (!activeStoryline) return;

    if (action === 'deleteStoryline') {
      const otherStorylines = storylines.filter(t => t.id !== activeStoryline.id);

      if (otherStorylines.length === 0) {
        alert('Cannot delete the last storyline. Create another storyline first.');
        return;
      }

      const confirmed = window.confirm(
        'Delete this storyline? All nodes will be moved to another storyline if available.'
      );

      if (!confirmed) return;

      try {
        const defaultStoryline = otherStorylines[0];
        const nodesInThisStoryline = storylineNodes;

        for (const node of nodesInThisStoryline) {
          const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);

          if (nodeStorylines.some(t => t.id === activeStoryline.id)) {
            if (nodeStorylines.length === 1) {
              await storylineUsecases.addNodeToStoryline(node.id, defaultStoryline.id);
            }
            await storylineUsecases.removeNodeFromStoryline(node.id, activeStoryline.id);
          }
        }

        await storylineUsecases.deleteStoryline(activeStoryline.id);
        navigate('/editor');
      } catch (error) {
        log.error('Failed to delete storyline:', error);
        alert('Failed to delete storyline. Please try again.');
      }
    }
  };

  const isGlobalLoading = (bookNodes.length === 0 && storylines.length === 0);

  if (isGlobalLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: '#999',
      }}>
        Loading storyline...
      </div>
    );
  }

  if (!activeStoryline) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: '#999',
      }}>
        Select a storyline to view
      </div>
    );
  }

  const hasEditorContent = (editor?.getText().trim().length ?? 0) > 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      position: 'relative',
      overflow: 'auto',
      paddingLeft: 64,
      paddingRight: 'auto',
      paddingTop: 16,
      paddingBottom: 16,
      scrollbarWidth: 'none',
    }}>
      {/* let the whole area scrollable */}
      <div>
        {/* Storyline Name */}
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') {
                  setNameValue(activeStoryline.name);
                  setEditingName(false);
                }
              }}
              onFocus={(e) => e.target.select()}
              autoFocus
              style={{
                maxWidth: '50vw',
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
                maxWidth: '50vw',
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
              {activeStoryline.name || 'Untitled Storyline'}
            </h1>
          )}
        </div>

        {/* Description - Rich text editor */}
        <div style={{ marginBottom: 16, marginRight: '40%' }}>
          {hasEditorContent && (
            <div style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'rgba(0, 0, 0, 0.45)',
              marginBottom: 8,
            }}>
              Summary
            </div>
          )}
          <div>
            <EditorContent editor={editor} />
          </div>
        </div>

        <StorylineAllChapterEditor nodes={storylineNodes} onCurrentChapterChange={() => { }} />

        {/* Editor Context Menu */}
        <EditorContextMenu
          editorType="storyline"
          onAction={handleContextAction}
        />
      </div>
    </div>
  );
}
