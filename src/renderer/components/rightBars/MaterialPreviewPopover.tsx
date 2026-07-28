import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import type { LibraryItem } from '../../domain/library-item';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

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
 * Image / PDF items open in the OS default app via
 * `platform.material.openLocal` and never reach this popover. URL items open
 * in the system browser via `openExternal`. Both code paths live in the panel.
 */
export function MaterialPreviewPopover({ item, onClose }: Props) {
  const { t } = useTranslation();
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

  return (
    <ModalRoot onClose={onClose} ariaLabel={item.title || 'Untitled'}>
      <ModalCard width="min(720px, 92vw)">
        <ModalHeader
          kicker={t('materialPreview.kicker')}
          title={item.title || 'Untitled'}
          onClose={onClose}
          closeLabel={t('materialPreview.closeTitle')}
        />
        <ModalBody>
          <EditorContent editor={editor} />
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}
