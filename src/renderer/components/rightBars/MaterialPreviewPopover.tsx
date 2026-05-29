import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import type { LibraryItem } from '../../domain/library-item';

interface Props {
  item: LibraryItem;
  onClose: () => void;
}

/**
 * Floating preview for `kind === 'text'` library items.
 *
 * Mounts a read-only TipTap instance with the StarterKit so paragraphs /
 * headings / lists / blockquotes render uniformly.
 *
 * Image / PDF items open in the OS default app via `electronAPI.material.
 * openLocal` and never reach this popover. URL items open in the system
 * browser via `openExternal`. Both code paths live in the panel itself.
 */
export function MaterialPreviewPopover({ item, onClose }: Props) {
  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
    ],
    content: null,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        spellcheck: 'false',
      },
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let json: JSONContent = { type: 'doc', content: [] };
    const raw = item.bodyJson;
    if (raw && raw !== '{}' && raw !== 'null') {
      try {
        const parsed = JSON.parse(raw) as JSONContent;
        if (parsed && parsed.type === 'doc' && Array.isArray(parsed.content)) {
          json = parsed;
        }
      } catch {
        /* fall through to empty doc */
      }
    }
    try {
      const node = PMNode.fromJSON(editor.schema, json);
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, node.content);
      tr.setMeta('addToHistory', false);
      editor.view.dispatch(tr);
    } catch {
      /* leave editor empty */
    }
  }, [editor, item.bodyJson]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
      ) {
        document.activeElement.blur();
      }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'hsl(var(--ink-1) / 0.30)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'hsl(var(--paper))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 8,
          width: 'min(720px, 92vw)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 48px -16px hsl(var(--ink-1) / 0.30)',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid hsl(var(--rule))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: 'hsl(var(--ink-4))',
              }}
            >
              Library · 片段
            </div>
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                fontWeight: 500,
                color: 'hsl(var(--ink-1))',
                lineHeight: 1.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.title || 'Untitled'}
            </div>
          </div>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              padding: '4px 8px',
              borderRadius: 3,
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>
        <div
          style={{
            padding: '14px 20px 18px',
            overflowY: 'auto',
            flex: 1,
            minHeight: 0,
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
