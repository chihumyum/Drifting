import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { MaterialEmbed } from '../../lib/extensions/note-blocks';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { useStoredLibraryItemVariant } from './library-item-media';
import type { LibraryItem } from '../../domain/library-item';

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
  return (
    <NodeViewWrapper
      as="figure"
      className={`note-embed${selected ? ' note-embed--selected' : ''}`}
      data-material-embed=""
      data-drag-handle=""
      contentEditable={false}
    >
      {item ? <EmbeddedMaterial item={item} onOpen={open} /> : (
        <div className="note-embed__missing">{t('materialEditor.embed.missing')}</div>
      )}
    </NodeViewWrapper>
  );
}

function EmbeddedMaterial({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
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
    <button type="button" className="note-embed__card" onClick={onOpen}>
      {thumbnail.fileUrl ? <img src={thumbnail.fileUrl} alt="" draggable={false} /> : <span className="note-embed__glyph">PDF</span>}
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
