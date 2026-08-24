import { useEditor, EditorContent } from '@tiptap/react';
import { useLayoutEffect, useRef } from 'react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { createDefaultSlashMenu } from '../../lib/slash-menu';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ElementTemplateEditor');
log.setLevel(loglevel.levels.WARN);

interface Props {
  templateJson: string | null;
  onPersist: (templateJson: string) => void;
  placeholder?: string;
}

function parseTemplateJson(templateJson: string | null): JSONContent {
  const empty: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
  if (!templateJson || templateJson === '{}') return empty;
  try {
    const parsed = JSON.parse(templateJson) as JSONContent;
    if (parsed && parsed.type === 'doc' && Array.isArray(parsed.content)) return parsed;
  } catch (error) {
    log.warn('Failed to parse template JSON, falling back to empty doc:', error);
  }
  return empty;
}

// Plain TipTap editor for a category's element template. Intentionally simpler
// than useEntityEditor: no entity links, no mentions, no slash menu, no
// reference projection — this doc is structural (a default heading skeleton
// for new elements), not user-facing content. Persist on every update.
export function ElementTemplateEditor({ templateJson, onPersist, placeholder }: Props) {
  const initialContent = parseTemplateJson(templateJson);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Match the main editor: no code or lists in this novel-writing app.
        // Templates seed element editors (useEntityEditor) which drop these
        // nodes, so the skeleton must not be able to contain them either —
        // otherwise a templated element would fail schema validation on load.
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        code: false,
        codeBlock: false,
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
      // Slash menu — same defaults as the main editor (paragraph/h1/h2/h3/
      // quote/hr/align). No extra items: this surface is just for shaping
      // the template skeleton, no entity links / patches / markdown export.
      createDefaultSlashMenu(),
    ],
    // Constructor-time content is essential here: effect-time seeding paints
    // the empty-editor placeholder for one frame on every category/storyline
    // mount before replacing it with the real template.
    content: initialContent,
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

  const appliedTemplateRef = useRef(templateJson);
  useLayoutEffect(() => {
    if (appliedTemplateRef.current === templateJson) return;
    appliedTemplateRef.current = templateJson;
    if (!editor || editor.isDestroyed) return;
    try {
      const docNode = PMNode.fromJSON(editor.schema, parseTemplateJson(templateJson));
      const tr = editor.state.tr.replaceWith(
        0,
        editor.state.doc.content.size,
        docNode.content,
      );
      tr.setMeta('addToHistory', false);
      tr.setMeta('preventUpdate', true);
      editor.view.dispatch(tr);
    } catch (error) {
      log.warn('Failed to apply updated template JSON:', error);
    }
  }, [editor, templateJson]);

  return <EditorContent editor={editor} />;
}
