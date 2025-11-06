import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { AlignLeft, AlignCenter, AlignRight, ChevronRight, ChevronLeft } from 'lucide-react';
import { useState, useEffect } from 'react';

interface EditorMenuBarProps {
  editor: Editor | null;
}

export function EditorMenuBar({ editor }: EditorMenuBarProps) {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('editorMenuBarCollapsed');
    return saved === 'true';
  });

  useEffect(() => {
    localStorage.setItem('editorMenuBarCollapsed', String(isCollapsed));
  }, [isCollapsed]);

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
        isAlignLeft: ctx.editor.isActive({ textAlign: 'left' }) ?? false,
        isAlignCenter: ctx.editor.isActive({ textAlign: 'center' }) ?? false,
        isAlignRight: ctx.editor.isActive({ textAlign: 'right' }) ?? false,
      };
    },
  });

  if (!editor || !editorState) {
    return null;
  }

  const buttonClassName = (isActive: boolean) => 
    isActive ? 'bg-accent text-paper' : 'bg-paper-hover hover:bg-accent hover:text-paper transition-colors';

  const buttonStyle = (isActive: boolean) => ({
    padding: '10px 12px',
    border: isActive ? 'none' : '1px solid var(--accent-border, #e8dcc8)',
    borderRadius: 8,
    color: isActive ? '#fefdfb' : '#5a4a3a',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
  });

  const menuBarStyle = {
    position: 'fixed' as const,
    top: 16,
    right: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '12px 8px',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(139, 115, 85, 0.15)',
    border: '1px solid var(--accent-border, #e8dcc8)',
    backdropFilter: 'blur(12px)',
    zIndex: 100,
    transition: 'top 0.3s ease',
    pointerEvents: 'auto' as const,
    minWidth: 52,
  };

  const separatorStyle = {
    height: 1,
    background: 'var(--accent-border, #e8dcc8)',
    margin: '4px 0',
  };


  return (
    <div style={menuBarStyle} className="bg-paper-light">
      {/* Toggle Button */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
        style={{
          ...buttonStyle(false),
          marginBottom: isCollapsed ? 0 : 6,
        }}
        title={isCollapsed ? 'Expand Menu' : 'Collapse Menu'}
      >
        {isCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      {/* Format Buttons - Hidden when collapsed */}
      {!isCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={!editorState.canBold}
        className={buttonClassName(editorState.isBold)}
        style={buttonStyle(editorState.isBold)}
        title="Bold (Cmd+B)"
      >
        <strong>B</strong>
      </button>
      
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={!editorState.canItalic}
        className={buttonClassName(editorState.isItalic)}
        style={buttonStyle(editorState.isItalic)}
        title="Italic (Cmd+I)"
      >
        <em>I</em>
      </button>

      <div style={separatorStyle} />

      <button
        onClick={() => editor.chain().focus().setParagraph().run()}
        className={buttonClassName(editorState.isParagraph)}
        style={buttonStyle(editorState.isParagraph)}
        title="Paragraph"
      >
        P
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={buttonClassName(editorState.isHeading1)}
        style={buttonStyle(editorState.isHeading1)}
        title="Heading 1"
      >
        H1
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={buttonClassName(editorState.isHeading2)}
        style={buttonStyle(editorState.isHeading2)}
        title="Heading 2"
      >
        H2
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        className={buttonClassName(editorState.isHeading3)}
        style={buttonStyle(editorState.isHeading3)}
        title="Heading 3"
      >
        H3
      </button>

      <div style={separatorStyle} />

      <button
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={buttonClassName(editorState.isBlockquote)}
        style={buttonStyle(editorState.isBlockquote)}
        title="Blockquote"
      >
        "
      </button>

      <button
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        className={buttonClassName(false)}
        style={buttonStyle(false)}
        title="Horizontal Rule"
      >
        ―
      </button>

      <div style={separatorStyle} />

      <button
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        className={buttonClassName(editorState.isAlignLeft)}
        style={buttonStyle(editorState.isAlignLeft)}
        title="Align Left"
      >
        <AlignLeft size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        className={buttonClassName(editorState.isAlignCenter)}
        style={buttonStyle(editorState.isAlignCenter)}
        title="Align Center"
      >
        <AlignCenter size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        className={buttonClassName(editorState.isAlignRight)}
        style={buttonStyle(editorState.isAlignRight)}
        title="Align Right"
      >
        <AlignRight size={16} />
      </button>
      </div>
      )}
    </div>
  );
}
