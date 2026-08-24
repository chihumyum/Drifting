import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useTranslation } from 'react-i18next';
import type { JSONContent } from '@tiptap/core';
import type { LibraryItem } from '../../domain/library-item';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

interface Props {
  item: LibraryItem;
  onClose: () => void;
}

function parsePreviewBody(bodyJson: string | null): JSONContent {
  const empty: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
  if (!bodyJson || bodyJson === '{}' || bodyJson === 'null') return empty;
  try {
    const parsed = JSON.parse(bodyJson) as JSONContent;
    if (parsed && parsed.type === 'doc' && Array.isArray(parsed.content)) return parsed;
  } catch {
    // A malformed legacy projection is displayed as an empty read-only preview.
  }
  return empty;
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
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          bulletList: { keepMarks: true },
          orderedList: { keepMarks: true },
        }),
      ],
      // The preview is born with its real document; a post-paint transaction
      // would briefly reveal an empty modal body before installing the prose.
      content: parsePreviewBody(item.bodyJson),
      editorProps: {
        attributes: {
          class: 'prose max-w-none focus:outline-none',
          spellcheck: 'false',
        },
      },
    },
    [item.id],
  );

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
