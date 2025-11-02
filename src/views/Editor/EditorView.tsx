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
import { useBookNodeUsecases } from '../../hooks/useBookNodeUsecases';

const DEFAULT_DOC_STRING = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '开始写作...' },
      ],
    },
  ],
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
    setBookContent,
    bookContent,
    bookNodes,
  } = useAppStore();

  const { loadNodes } = useBookNodeUsecases();
  const { loadContent, updateContent, newContent } = useBookContentUsecases();

  const [isContentLoading, setIsContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const bookContentRef = useRef(bookContent);
  const lastSyncedContentRef = useRef<string | null>(null);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    bookContentRef.current = bookContent;
  }, [bookContent]);

  useEffect(() => {
    if (!nodeId) {
      navigate('/', { replace: true });
      return;
    }

    if (selectedNodeId !== nodeId) {
      setSelectedNodeId(nodeId);
    }
  }, [navigate, nodeId, selectedNodeId, setSelectedNodeId]);

  useEffect(() => {
    if (!nodeId) return;
    // Lazily load nodes if navigator hasn't already hydrated them
    if (!bookNodes.length) {
      void loadNodes({ type: 'chapter' }).catch((error) => {
        console.error('Failed to load chapters for editor', error);
      });
    }
  }, [bookNodes.length, loadNodes, nodeId]);

  useEffect(() => {
    if (!nodeId) return;
    setIsContentLoading(true);
    setContentError(null);
    setBookContent(null);
    lastSyncedContentRef.current = null;

    let cancelled = false;

    void (async () => {
      try {
        await loadContent(nodeId);
      } catch (error) {
        console.error('Failed to load chapter content', error);
        if (!cancelled) {
          setContentError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setIsContentLoading(false);
        }
      }
    })();
    console.log('Loading content for node', nodeId);
    console.log('Current book content in store', bookContentRef.current);
    return () => {
      cancelled = true;
    };
  }, [loadContent, nodeId, setBookContent]);

  useEffect(() => {
    if (!nodeId) return;
    if (!bookNodes.length) return;
    const exists = bookNodes.some((node) => node.id === nodeId);
    if (!exists) {
      setContentError('未找到对应的章节节点');
    }
  }, [bookNodes, nodeId]);

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
      const activeNodeId = selectedNodeIdRef.current;
      if (!activeNodeId) return;
      const json = ed.getJSON();
      const pmJson = JSON.stringify(json);
      console.log('Json to update', pmJson);
      if (pmJson === lastSyncedContentRef.current) return;
      lastSyncedContentRef.current = pmJson;
      
      const currentContent = bookContentRef.current;
      if (currentContent && currentContent.id) {
        void updateContent({
          id: currentContent.id,
          nodeId: currentContent.nodeId ?? activeNodeId,
          pmJson,
        });
        console.log(`Updated for ${currentContent.id}, content is now ${bookContentRef.current?.pmJson}`);
      } else {
        void newContent(activeNodeId, pmJson);
      }
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!isContentLoading);
  }, [editor, isContentLoading]);

  useEffect(() => {
    if (!editor) return;
    if (!nodeId) return;
    const content = bookContent && bookContent.nodeId === nodeId ? bookContent : null;
    console.log('Starting with content', content);
    if (content?.pmJson) {
      const pmJson = content.pmJson;
      if (pmJson === lastSyncedContentRef.current) return;
      try {
        const doc = JSON.parse(pmJson) as JSONContent;
        editor.commands.setContent(doc, false);
        lastSyncedContentRef.current = pmJson;
      } catch (error) {
        console.error('Failed to parse editor content; falling back to default doc', error);
        editor.commands.setContent(getDefaultDoc(), false);
        lastSyncedContentRef.current = DEFAULT_DOC_STRING;
        setContentError('章节内容解析失败，已恢复默认内容');
      }
    } else if (!isContentLoading && lastSyncedContentRef.current !== DEFAULT_DOC_STRING) {
      console.log('No content found, setting default doc');
      editor.commands.setContent(getDefaultDoc(), false);
      lastSyncedContentRef.current = DEFAULT_DOC_STRING;
    }
  }, [bookContent, editor, isContentLoading, nodeId]);

  const currentNode = useMemo(
    () => (nodeId ? bookNodes.find((node) => node.id === nodeId) ?? null : null),
    [bookNodes, nodeId],
  );

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, color: '#302432' }}>
              {currentNode?.title ?? '加载章节中…'}
            </div>
            <div style={{ fontSize: 12, color: '#8b7c8b', marginTop: 6 }}>
              {currentNode ? `状态：${currentNode.status.replace('_', ' ')}` : '请稍候，正在获取章节信息'}
            </div>
          </div>
          {isContentLoading && (
            <div style={{ fontSize: 12, color: '#8c7d8c' }}>
              正在加载内容…
            </div>
          )}
        </div>

        {contentError && (
          <div
            style={{
              marginTop: 18,
              padding: '12px 16px',
              borderRadius: 12,
              background: 'rgba(216,82,82,0.12)',
              color: '#b23c3c',
              fontSize: 12,
            }}
          >
            {contentError}
          </div>
        )}

        <div
          style={{
            marginTop: 28,
            borderRadius: 26,
            background: '#ffffff',
            boxShadow: '0 30px 60px rgba(31, 26, 58, 0.12)',
            padding: '32px 38px',
            minHeight: 520,
            opacity: isContentLoading ? 0.6 : 1,
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
