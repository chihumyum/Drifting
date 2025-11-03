import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

interface EditorMenuBarProps {
  editor: Editor | null;
}

export function EditorMenuBar({ editor }: EditorMenuBarProps) {
  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) return null;
      return {
        isBold: ctx.editor.isActive('bold') ?? false,
        canBold: ctx.editor.can().chain().toggleBold().run() ?? false,
        isItalic: ctx.editor.isActive('italic') ?? false,
        canItalic: ctx.editor.can().chain().toggleItalic().run() ?? false,
        isParagraph: ctx.editor.isActive('paragraph') ?? false,
        isHeading1: ctx.editor.isActive('heading', { level: 1 }) ?? false,
        isHeading2: ctx.editor.isActive('heading', { level: 2 }) ?? false,
        isHeading3: ctx.editor.isActive('heading', { level: 3 }) ?? false,
        isBlockquote: ctx.editor.isActive('blockquote') ?? false,
      };
    },
  });

  if (!editor || !editorState) {
    return null;
  }

  const buttonStyle = (isActive: boolean) => ({
    padding: '8px 14px',
    border: 'none',
    borderRadius: 8,
    background: isActive ? '#6366f1' : '#f3f4f6',
    color: isActive ? '#ffffff' : '#374151',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    boxShadow: isActive ? '0 4px 12px rgba(99, 102, 241, 0.3)' : 'none',
  });

  const menuBarStyle = {
    position: 'fixed' as const,
    top: 32,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: 8,
    padding: '12px 16px',
    background: 'rgba(255, 255, 255, 0.98)',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.05)',
    backdropFilter: 'blur(12px)',
    zIndex: 50,
  };

  const separatorStyle = {
    width: 1,
    background: '#e5e7eb',
    margin: '0 4px',
  };

  return (
    <div style={menuBarStyle}>
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={!editorState.canBold}
        style={buttonStyle(editorState.isBold)}
        title="Bold (Cmd+B)"
      >
        <strong>B</strong>
      </button>
      
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={!editorState.canItalic}
        style={buttonStyle(editorState.isItalic)}
        title="Italic (Cmd+I)"
      >
        <em>I</em>
      </button>

      <div style={separatorStyle} />

      <button
        onClick={() => editor.chain().focus().setParagraph().run()}
        style={buttonStyle(editorState.isParagraph)}
        title="Paragraph"
      >
        P
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        style={buttonStyle(editorState.isHeading1)}
        title="Heading 1"
      >
        H1
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        style={buttonStyle(editorState.isHeading2)}
        title="Heading 2"
      >
        H2
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        style={buttonStyle(editorState.isHeading3)}
        title="Heading 3"
      >
        H3
      </button>

      <div style={separatorStyle} />

      <button
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        style={buttonStyle(editorState.isBlockquote)}
        title="Blockquote"
      >
        "
      </button>

      <button
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        style={buttonStyle(false)}
        title="Horizontal Rule"
      >
        ―
      </button>
    </div>
  );
}
