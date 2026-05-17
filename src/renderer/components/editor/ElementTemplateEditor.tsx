import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect } from 'react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { createDefaultSlashMenu } from '../../lib/slash-menu';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ElementTemplateEditor');
log.setLevel(loglevel.levels.WARN);

interface Props {
  templateJson: string | null;
  onPersist: (templateJson: string) => void;
  placeholder?: string;
}

// Plain TipTap editor for a category's element template. Intentionally simpler
// than useEntityEditor: no entity links, no mentions, no slash menu, no
// reference projection — this doc is structural (a default heading skeleton
// for new elements), not user-facing content. Persist on every update.
export function ElementTemplateEditor({ templateJson, onPersist, placeholder }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
      // Slash menu — same defaults as the main editor (paragraph/h1/h2/h3/
      // lists/quote/etc). No extra items: this surface is just for shaping
      // the template skeleton, no entity links / patches / markdown export.
      createDefaultSlashMenu(),
    ],
    content: null,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const next = JSON.stringify(ed.getJSON());
      onPersist(next);
    },
  });

  // Load templateJson into the editor without polluting undo history.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let json: JSONContent = { type: 'doc', content: [] };
    if (templateJson && templateJson !== '{}') {
      try {
        const parsed = JSON.parse(templateJson) as JSONContent;
        if (parsed && parsed.type === 'doc' && Array.isArray(parsed.content)) {
          json = parsed;
        }
      } catch (error) {
        log.warn('Failed to parse template JSON, falling back to empty doc:', error);
      }
    }
    try {
      const docNode = PMNode.fromJSON(editor.schema, json);
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, docNode.content);
      tr.setMeta('addToHistory', false);
      editor.view.dispatch(tr);
    } catch (error) {
      log.warn('Failed to seed template editor:', error);
    }
    // templateJson is intentionally NOT in deps — we only seed once per editor
    // instance. Subsequent edits live in the editor's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return <EditorContent editor={editor} />;
}
