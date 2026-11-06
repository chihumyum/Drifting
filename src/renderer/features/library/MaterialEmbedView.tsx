import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { MaterialEmbed } from '../../lib/extensions/note-blocks';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { useStoredLibraryItemVariant } from './library-item-media';
import type { LibraryItem } from '../../domain/library-item';
import { KindMark } from '../../components/ui/KindMark';
import { BrushIcon } from '../../components/ui/BrushIcon';

/**
 * A material embedded in a note. The node only references the material, so
 * renaming or replacing it shows up here, and a deleted material leaves a
 * quiet placeholder instead of breaking the note.
 */
function MaterialEmbedNodeView({ node, selected }: ReactNodeViewProps) {
  const { t } = useTranslation();
  const navigator = useWorkspaceNavigator();
  const libraryItemId = typeof node.attrs.libraryItemId === 'string' ? node.attrs.libraryItemId : null;
  const item = useDataStore(
    (state) => state.libraryItems.find((candidate) => candidate.id === libraryItemId) ?? null,
  );
  const open = () => {
    if (item) navigator.open({ entityType: 'library_item', id: item.id });
  };
  // An image takes glass only under the pointer or when the node is
  // selected; a PDF is a card with the resting line of glass.
  const image = item?.kind === 'image';
  return (
    <NodeViewWrapper
      as="figure"
      className={[
        'note-embed',
        selected ? 'note-embed--selected' : '',
        'note-embed--glass',
        image ? 'glass' : '',
        image && selected ? 'is-on' : '',
      ].filter(Boolean).join(' ')}
      data-material-embed=""
      data-drag-handle=""
      contentEditable={false}
    >
      {item ? <EmbeddedMaterial item={item} onOpen={open} selected={selected} /> : (
        <div className="note-embed__missing note-embed__missing--quiet">
          <BrushIcon name="status-warning" size={13} />
          {t('materialEditor.embed.missing')}
        </div>
      )}
    </NodeViewWrapper>
  );
}

function EmbeddedMaterial({
  item,
  onOpen,
  selected,
}: {
  item: LibraryItem;
  onOpen: () => void;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const display = useStoredLibraryItemVariant(item, 'display', item.kind === 'image');
  const thumbnail = useStoredLibraryItemVariant(item, 'thumbnail', item.kind === 'pdf');
  if (item.kind === 'image') {
    return (
      <>
        {display.fileUrl ? (
          <img className="note-embed__image" src={display.fileUrl} alt={item.title} draggable={false} onDoubleClick={onOpen} />
        ) : (
          <div className="note-embed__missing">{t('memoMaterial.preview.loading')}</div>
        )}
        <figcaption className="note-embed__caption">
          <button type="button" onClick={onOpen}>{item.title || t('common.untitled')}</button>
        </figcaption>
      </>
    );
  }
  return (
    <button
      type="button"
      className={`note-embed__card note-embed__card--glass glass glass--rest${selected ? ' is-on' : ''}`}
      onClick={onOpen}
    >
      {thumbnail.fileUrl ? (
        <img src={thumbnail.fileUrl} alt="" draggable={false} />
      ) : (
        <span className="note-embed__glyph"><KindMark kind="material" /></span>
      )}
      <span className="note-embed__card-title">{item.title || t('common.untitled')}</span>
      <span className="note-embed__card-kind">{t(`memoMaterial.kind.${item.kind}`)}</span>
    </button>
  );
}

/** The note editor's embed node with its live React view. */
export const MaterialEmbedWithView = MaterialEmbed.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MaterialEmbedNodeView);
  },
});
