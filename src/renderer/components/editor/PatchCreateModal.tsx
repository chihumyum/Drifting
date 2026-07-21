import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import { X } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useBookElement } from '../../usecase/useBookElement';
import { useAuthStore } from '../../store/auth';
import { createElementPatchWithSync } from '../../usecase/synced-entity-commands';
import { createPlainCommentDoc } from '../../domain/comment';
import { eventBus } from '../../lib/events';
import type { PatchCreateRequest } from './patch-create-request';

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
  const { bookElements } = useDataStore();
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

  // Escape closes.
  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-28 bg-black/40"
      onMouseDown={onClose}
    >
      <div
        className="flex w-[460px] max-h-[72vh] flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{t('patchCreateModal.title')}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t('patchCreateModal.subtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('common.close')}
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* Anchored selection quote */}
          <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            <span className="mr-1 select-none text-foreground/40">“</span>
            {request.selectedText}
            <span className="ml-0.5 select-none text-foreground/40">”</span>
          </div>

          {/* Element target */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium text-muted-foreground">{t('patchCreateModal.targetElement')}</label>
            {elementId ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                  {t('globalSearch.entity.element')}
                </span>
                <span className="flex-1 truncate text-sm">{elementName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setElementId(null);
                    setQuery('');
                    setElementName('');
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('patchCreateModal.changeElement')}
                </button>
              </div>
            ) : (
              <>
                <input
                  ref={searchRef}
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('patchCreateModal.searchElement')}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
                />
                <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                  {candidates.length === 0 && !noExactMatch ? (
                    <div className="px-2.5 py-2 text-xs italic text-muted-foreground">
                      {t('patchCreateModal.noElements')}
                    </div>
                  ) : (
                    candidates.map((el) => (
                      <button
                        key={el.id}
                        type="button"
                        onClick={() => pickElement(el.id, el.name)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('globalSearch.entity.element')}
                        </span>
                        <span className="truncate">{el.name}</span>
                      </button>
                    ))
                  )}
                  {noExactMatch && (
                    <button
                      type="button"
                      onClick={handleCreateElement}
                      className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t('patchCreateModal.newElement')}
                      </span>
                      <span className="truncate">{t('patchCreateModal.createElement', { name: query.trim() })}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium text-muted-foreground">{t('patchCreateModal.patchTitle')}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('patchCreateModal.titlePlaceholder')}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
            />
          </div>

          {/* Body */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium text-muted-foreground">{t('patchCreateModal.body')}</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('patchCreateModal.bodyPlaceholder')}
              rows={4}
              className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-relaxed outline-none focus:border-ring"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleCreatePatch}
            disabled={!elementId || busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('patchCreateModal.createPatch')}
          </button>
        </div>
      </div>
    </div>
  );
}
