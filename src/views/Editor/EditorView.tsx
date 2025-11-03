import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { createDefaultSlashMenu } from '@chi-hum/tiptap-simple-slash-menu';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../../store';
import { useBookContentUsecases } from '../../hooks/useBookContentUsecases';

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
    selectedNodeId,
    setSelectedNodeId,
    bookContent,
  } = useAppStore();

  const { loadContent, updateContent, newContent } = useBookContentUsecases();
  
  // Track if content has been loaded to prevent premature saves
  const isContentLoadedRef = useRef(false);

  // get nodeId from url
  useEffect(() => {
    if (!nodeId) {
      navigate('/', { replace: true });
      return;
    }
    if (selectedNodeId !== nodeId) {
      setSelectedNodeId(nodeId);
    }
  }, [nodeId, navigate, selectedNodeId, setSelectedNodeId]);


  // load content when nodeId changes
  useEffect(() => {
    if (!nodeId) return;

    // Reset flag when switching nodes
    isContentLoadedRef.current = false;
    
    void (async () => {
      try {
        await loadContent(nodeId);
        // Mark content as loaded after successful load
        isContentLoadedRef.current = true;
      } catch (error) {
        console.error('Failed to load chapter content', error);
        isContentLoadedRef.current = true; // Still mark as loaded to allow editing
      }
    })();
  }, [loadContent, nodeId]);


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
    autofocus: true,
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
      if (bookContent && bookContent.id) {
        void updateContent({
          id: bookContent.id,
          nodeId: bookContent.nodeId,
          pmJson,
        });
      } else {
        if (!nodeId) return;
        console.log('Creating new content for node', nodeId);
        void newContent(nodeId, pmJson);
      }
    },
  });

  // load set book content into editor
  useEffect(() => {
    if (!editor) {
      console.log('Editor not ready yet');
      return;
    }
    if (!nodeId) {
      console.log('No nodeId provided');
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
        console.log('Set editor content from book content');
      } catch (error) {
        console.error('Failed to parse editor content; falling back to default doc', error);
        editor.commands.setContent(getDefaultDoc());
      }
    } else { // only set default doc when book content is null
      console.log('No content found, setting to default doc');
      editor.commands.setContent(getDefaultDoc());
    }
    
    // Mark content as fully loaded after setting it in the editor
    // Use a small delay to ensure the editor has processed the content
    setTimeout(() => {
      isContentLoadedRef.current = true;
    }, 0);
  }, [bookContent, editor, nodeId]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '80px 48px',
        background: 'rgba(18,16,32,0.45)',
        backdropFilter: 'blur(16px)',
      }}
    >
      <button
        type="button"
        onClick={() => navigate('/graph')}
        style={{
          position: 'absolute',
          top: 32,
          left: 48,
          padding: '10px 18px',
          borderRadius: 999,
          border: 'none',
          background: '#ffffff',
          color: '#312a34',
          fontSize: 13,
          fontWeight: 600,
          boxShadow: '0 14px 32px rgba(22,18,46,0.22)',
          cursor: 'pointer',
        }}
      >
        ← 返回章节
      </button>

      <div
        style={{
          position: 'relative',
          width: 'min(960px, 100%)',
          minHeight: '70vh',
          borderRadius: 32,
          background: '#fdfcfe',
          boxShadow: '0 48px 120px rgba(20, 18, 40, 0.28)',
          padding: '40px 56px 48px 56px',
        }}
      >


        <div
          style={{
            marginTop: 28,
            borderRadius: 26,
            background: '#ffffff',
            boxShadow: '0 30px 60px rgba(31, 26, 58, 0.12)',
            padding: '32px 38px',
            minHeight: 520,
            transition: 'opacity 0.2s ease',
          }}
        >
          <EditorContent
            editor={editor}
            style={{
              background: 'transparent',
              minHeight: 440,
            }}
          />
        </div>
      </div>
    </div>
  );
}
