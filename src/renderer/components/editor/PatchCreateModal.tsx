import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import { useDataStore } from '../../store/data-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { useBookElement } from '../../usecase/useBookElement';
import { useAuthStore } from '../../store/auth';
import { createElementPatchWithSync } from '../../usecase/synced-entity-commands';
import { createPlainCommentDoc } from '../../domain/comment';
import { eventBus } from '../../lib/events';
import type { PatchCreateRequest } from './patch-create-request';
import { BrushIcon } from '../ui/BrushIcon';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { KindMark } from '../ui/KindMark';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const log = loglevel.getLogger('PatchCreateModal');
log.setLevel(loglevel.levels.ERROR);

interface PatchCreateModalProps {
  projectId: string;
  request: PatchCreateRequest | null; // null = closed
  onClose: () => void;
  onCreated?: (patchId: string, elementId: string) => void;
}

// Opened from the chapter editor's text-selection context menu ("新建补丁").
// Lets the user pick (or create) the target element and author the patch's
// title + body inline, then creates the patch anchored to the selected text.
// Themed with shadcn tokens (bg-card / text-foreground / …) so it adapts to
// light + dark automatically.
export function PatchCreateModal({ projectId, request, onClose, onCreated }: PatchCreateModalProps) {
  const { t } = useTranslation();
  const { bookElements } = useDataStoreFields('bookElements');
  const userId = useAuthStore((state) => state.user?.id);
  // userId can briefly be undefined during initial auth load; useBookElement
  // requires a non-empty string, so guard the hook with a stable fallback.
  const { createElement } = useBookElement({
    projectId,
    userId: userId ?? '__unauthenticated__',
  });

  const [query, setQuery] = useState('');
  const [elementId, setElementId] = useState<string | null>(null);
  const [elementName, setElementName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset the form whenever the modal (re)opens for a new selection. Done at
  // render time via the prev-snapshot pattern (each open passes a fresh request
  // object) rather than in an effect, to avoid the setState-in-effect cascade —
  // matches ChapterEditor's syncedKey convention.
  const [openedFor, setOpenedFor] = useState(request);
  if (openedFor !== request) {
    setOpenedFor(request);
    if (request) {
      setQuery('');
      setElementId(null);
      setElementName('');
      setTitle('');
      setBody('');
      setBusy(false);
    }
  }

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bookElements
      .filter((el) => (q ? el.name.toLowerCase().includes(q) : true))
      .slice(0, 50);
  }, [bookElements, query]);

  const noExactMatch =
    !!query.trim() &&
    !bookElements.some((e) => e.name.toLowerCase() === query.trim().toLowerCase());

  const pickElement = (id: string, name: string) => {
    setElementId(id);
    setElementName(name);
  };

  const handleCreateElement = async () => {
    const name = query.trim();
    if (!name) return;
    const categoryId = useDataStore.getState().bookElementCategories[0]?.id;
    if (!categoryId) {
      log.warn('Cannot create element — project has no element categories');
      return;
    }
    try {
      const created = await createElement({ categoryId, name });
      if (created) pickElement(created.id, created.name);
    } catch (error) {
      log.error('Failed to create element:', error);
    }
  };

  const handleCreatePatch = async () => {
    if (!request || !elementId || busy) return;
    setBusy(true);
    try {
      const created = await createElementPatchWithSync({
        projectId,
        elementId,
        sourceNodeId: request.sourceNodeId,
        sourceBlockId: request.sourceBlockId,
        sourceBlockText: request.sourceBlockText,
        textAnchorJson: request.textAnchorJson,
        title: title.trim() || null,
        contentJson: body.trim() ? createPlainCommentDoc(body) : '{}',
      });
      // Refresh any open element editor's patch list.
      eventBus.emit('element:patches-changed', { elementId });
      onCreated?.(created.id, elementId);
      onClose();
    } catch (error) {
      log.error('Failed to create patch:', error);
      setBusy(false);
    }
  };

  if (!request) return null;
  // The shared dialog shell (Escape and the backdrop close it); the quoted
  // selection is a read-only card of glass, the target element carries its
  // square seal, candidates are menu rows, the note is the multi-line field.
  return (
    <ModalRoot onClose={onClose} ariaLabel={t('patchCreateModal.title')} className="patch-create-modal__overlay">
      <ModalCard className="patch-create-modal" width={460}>
        <ModalHeader
          title={t('patchCreateModal.title')}
          subtitle={t('patchCreateModal.subtitle')}
          onClose={onClose}
          closeLabel={t('common.close')}
        />
        <ModalBody>
          <section className="dialog-section">
            <div className="patch-create-modal__quote glass glass--rest glass--still">
              「{request.selectedText}」
            </div>
          </section>
          <section className="dialog-section">
            <span className="dialog-section__label">{t('patchCreateModal.targetElement')}</span>
            {elementId ? (
              <div className="patch-create-modal__picked">
                <KindMark kind="element" />
                <span className="patch-create-modal__picked-name">{elementName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setElementId(null);
                    setQuery('');
                    setElementName('');
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }}
                >
                  {t('patchCreateModal.changeElement')}
                </Button>
              </div>
            ) : (
              <>
                <label className="ui-field glass glass--rest glass--field">
                  <BrushIcon name="search" size={15} />
                  <input
                    ref={searchRef}
                    type="text"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('patchCreateModal.searchElement')}
                  />
                </label>
                <div className="patch-create-modal__candidates">
                  {candidates.length === 0 && !noExactMatch ? (
                    <EmptyState density="compact" mark="element" message={t('patchCreateModal.noElements')} />
                  ) : (
                    candidates.map((el) => (
                      <button
                        key={el.id}
                        type="button"
                        onClick={() => pickElement(el.id, el.name)}
                        className="menu-surface__item"
                      >
                        <KindMark kind="element" />
                        <span className="patch-create-modal__candidate-name">{el.name}</span>
                      </button>
                    ))
                  )}
                  {noExactMatch && (
                    <button type="button" onClick={handleCreateElement} className="menu-surface__item">
                      <BrushIcon name="plus" size={14} />
                      <span className="patch-create-modal__candidate-name">
                        {t('patchCreateModal.createElement', { name: query.trim() })}
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="dialog-section">
            <span className="dialog-section__label">{t('patchCreateModal.patchTitle')}</span>
            <label className="ui-field glass glass--rest glass--field">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('patchCreateModal.titlePlaceholder')}
              />
            </label>
          </section>
          <section className="dialog-section">
            <span className="dialog-section__label">{t('patchCreateModal.body')}</span>
            <label className="ui-field ui-field--area glass glass--rest glass--field">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t('patchCreateModal.bodyPlaceholder')}
                rows={4}
              />
            </label>
          </section>
        </ModalBody>
        <ModalActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleCreatePatch} disabled={!elementId || busy}>
            {t('patchCreateModal.createPatch')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
