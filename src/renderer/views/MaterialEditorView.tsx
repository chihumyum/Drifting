import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Maximize2, Minus, Plus } from 'lucide-react';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { requestConfirmation } from '../store/confirmation-store';
import { useCanPromoteOnEdit, usePromoteCurrentTab, useUiStore } from '../store/ui-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useLibraryItem } from '../usecase/useLibraryItem';
import { useEntityRelations } from '../usecase/useEntityRelations';
import { genericAssociationRelationTypeId } from '../domain/entity-relation-type';
import type { LibraryItem } from '../domain/library-item';
import { createPlainCommentDoc, extractTextFromCommentBody } from '../domain/comment';
import { parseMaterialProvenance } from '../domain/material-provenance';
import { EditorCrumb, EditorTopBar, MATERIAL_OPEN_IN_SYSTEM_ACTION } from '../components/editor/EditorTopBar';
import { EntityTitleField } from '../components/editor/EntityTitleField';
import {
  useEditorSurfaceLifecycle,
  useReportEditorSurfaceReady,
} from '../components/editor/editor-surface-lifecycle-context';
import { EntityRelationPicker, type RelationTarget } from '../components/rightBars/EntityRelationPicker';
import { useStoredLibraryItemVariant } from '../features/library/library-item-media';
import {
  ImageMediaStage,
  MediaStageMessage,
  PdfMediaStage,
} from '../features/library/MaterialMediaStage';
import { useZoomPanSurface } from '../features/library/use-zoom-pan-surface';
import { openLibraryItemInSystem } from '../features/library/open-library-item';
import { LibraryItemFullscreenPreview } from '../features/library/LibraryItemPreview';
import { MaterialNotePage } from './MaterialNotePage';

const log = loglevel.getLogger('MaterialEditorView');
log.setLevel(loglevel.levels.ERROR);

/**
 * A material (`library_item`) opened as a workspace tab or mobile paper.
 * Images and PDFs get a zoomable stage under a compact header; notes get a
 * page like the other entity editors.
 */
export function MaterialEditorView({
  libraryItemIdOverride,
}: { libraryItemIdOverride?: string } = {}) {
  const { t } = useTranslation();
  const params = useParams<{ projectId: string; libraryItemId: string }>();
  const projectId = params.projectId;
  const libraryItemId = libraryItemIdOverride ?? params.libraryItemId ?? '';
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required');
  if (!userId) throw new Error('User must be authenticated');

  const { isCommandActive } = useEditorSurfaceLifecycle();
  const item = useDataStore(
    (state) => state.libraryItems.find((candidate) => candidate.id === libraryItemId) ?? null,
  );
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const { leaveDeletedEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const canPromoteOnEdit = useCanPromoteOnEdit(libraryItemId);
  // Media is ready once mounted; a note waits for its document-bound editor.
  const [noteReady, setNoteReady] = useState(false);
  const isMedia = item?.kind === 'image' || item?.kind === 'pdf';
  useReportEditorSurfaceReady(!item || isMedia || noteReady);

  // Any authored change pins a preview tab, as in the other entity editors.
  const promoteOnEdit = useCallback(() => {
    if (isCommandActive && canPromoteOnEdit()) promoteCurrentTab();
  }, [canPromoteOnEdit, isCommandActive, promoteCurrentTab]);

  const update = useCallback(
    (patch: Parameters<typeof libraryItemUsecases.updateLibraryItem>[1]) => {
      if (!item) return;
      promoteOnEdit();
      void libraryItemUsecases.updateLibraryItem(item.id, patch).catch((error: unknown) => {
        log.error('Failed to update material:', error);
      });
    },
    [item, libraryItemUsecases, promoteOnEdit],
  );

  const handleMenuAction = useCallback(
    async (action: string) => {
      if (!item) return;
      if (action === MATERIAL_OPEN_IN_SYSTEM_ACTION) {
        const result = await openLibraryItemInSystem(projectId, item);
        if (!result.ok) alert(t('memoMaterial.error.openFile', { error: result.error }));
        return;
      }
      if (action === 'deleteMaterial') {
        const confirmed = await requestConfirmation(
          t('materialEditor.deleteConfirm', { title: item.title || t('common.untitled') }),
        );
        if (!confirmed) return;
        try {
          await libraryItemUsecases.removeLibraryItem(item.id);
          leaveDeletedEntity();
        } catch (error) {
          log.error('Failed to delete material:', error);
          alert(t('materialEditor.deleteFailed'));
        }
      }
    },
    [item, leaveDeletedEntity, libraryItemUsecases, projectId, t],
  );

  // Queued actions from tab/sidebar context menus (see NodeEditorView).
  const pendingEntityAction = useUiStore((state) => state.pendingEntityAction);
  const consumeEntityAction = useUiStore((state) => state.consumeEntityAction);
  useEffect(() => {
    if (!isCommandActive || !item || !pendingEntityAction) return;
    const queued = consumeEntityAction('library_item', item.id);
    if (queued) void handleMenuAction(queued);
  }, [consumeEntityAction, handleMenuAction, isCommandActive, item, pendingEntityAction]);

  if (!item) {
    return <div className="material-editor__missing">{t('materialEditor.missing')}</div>;
  }

  const kindLabel = t(`memoMaterial.kind.${item.kind}`, { defaultValue: item.kind });

  return (
    <div className="editor-shell material-editor" data-kind={item.kind}>
      <EditorTopBar
        editorType="library_item"
        onMenuAction={(action) => void handleMenuAction(action)}
        outlineToggle={false}
        hiddenMenuActions={isMedia ? undefined : [MATERIAL_OPEN_IN_SYSTEM_ACTION]}
      >
        <EditorCrumb>{t('materialEditor.crumb')}</EditorCrumb>
        <EditorCrumb>{kindLabel}</EditorCrumb>
      </EditorTopBar>
      {isMedia ? (
        <MaterialMediaPage key={item.id} item={item} projectId={projectId} userId={userId} onUpdate={update} />
      ) : (
        <MaterialNotePage
          key={item.id}
          item={item}
          projectId={projectId}
          userId={userId}
          onAuthoredEdit={promoteOnEdit}
          onReadyChange={setNoteReady}
          header={
            <>
              <MaterialTitle item={item} onUpdate={update} />
              <MaterialRelations item={item} projectId={projectId} userId={userId} />
            </>
          }
        />
      )}
    </div>
  );
}

type UpdateMaterial = (patch: { title?: string; notesJson?: string | null }) => void;

interface MaterialPageProps {
  item: LibraryItem;
  projectId: string;
  userId: string;
  onUpdate: UpdateMaterial;
}

function MaterialTitle({ item, onUpdate }: { item: LibraryItem; onUpdate: UpdateMaterial }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(item.title);
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState(false);
  const commit = () => {
    const next = draft.trim();
    if (next !== item.title) onUpdate({ title: next });
  };
  return (
    <EntityTitleField
      className="material-editor__title"
      value={editing ? draft : item.title}
      placeholder={t('common.untitled')}
      onFocus={() => {
        setDraft(item.title);
        setEditing(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={(event) => {
        setComposing(false);
        setDraft(event.currentTarget.value);
      }}
      onBlur={() => {
        setEditing(false);
        if (!composing) commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraft(item.title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Generic-association chips for the material, shared with the library cards. */
function MaterialRelations({
  item,
  projectId,
  userId,
}: {
  item: LibraryItem;
  projectId: string;
  userId: string;
}) {
  const entityRelations = useDataStore((state) => state.entityRelations);
  const relationUsecases = useEntityRelations({ projectId, userId });
  const genericTypeId = genericAssociationRelationTypeId(projectId);
  const relations = useMemo(
    () =>
      entityRelations.filter(
        (relation) =>
          relation.relationTypeId === genericTypeId &&
          relation.fromKind === 'library_item' &&
          relation.fromId === item.id,
      ),
    [entityRelations, genericTypeId, item.id],
  );
  const selected = useMemo(
    () => new Set(relations.map((relation) => `${relation.toKind}:${relation.toId}`)),
    [relations],
  );
  const add = (target: RelationTarget) => {
    void relationUsecases
      .addGenericAssociation('library_item', item.id, target.kind, target.id)
      .catch((error: unknown) => log.error('Failed to relate material:', error));
  };
  const remove = (target: RelationTarget) => {
    const relation = relations.find((candidate) => candidate.toKind === target.kind && candidate.toId === target.id);
    if (relation) void relationUsecases.removeRelation(relation.id);
  };
  return (
    <div className="material-editor__relations">
      <EntityRelationPicker selected={selected} onAdd={add} onRemove={remove} />
    </div>
  );
}

/** Origin line: who made this material (author import, generation, old portrait). */
function MaterialProvenanceLine({ item }: { item: LibraryItem }) {
  const { t } = useTranslation();
  const provenance = parseMaterialProvenance(item.provenanceJson);
  const elementName = useDataStore((state) => {
    if (provenance?.origin !== 'element-portrait') return null;
    return state.bookElements.find((element) => element.id === provenance.elementId)?.name ?? null;
  });
  const [open, setOpen] = useState(false);
  if (provenance?.origin === 'generated') {
    const generation = provenance.generation;
    return (
      <div className="material-editor__provenance">
        <button type="button" className="material-editor__provenance-toggle" onClick={() => setOpen((value) => !value)}>
          {t('materialEditor.provenance.generated', {
            model: generation.model,
            date: new Date(generation.generatedAt).toLocaleDateString(),
          })}
        </button>
        {open && (
          <dl className="material-editor__generation">
            <dt>{t('materialEditor.provenance.prompt')}</dt>
            <dd>{generation.subjectPrompt ?? generation.prompt}</dd>
            {generation.styleText && (
              <>
                <dt>{t('materialEditor.provenance.style')}</dt>
                <dd>{generation.styleText}</dd>
              </>
            )}
            {generation.extraPrompt && (
              <>
                <dt>{t('materialEditor.provenance.direction')}</dt>
                <dd>{generation.extraPrompt}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    );
  }
  if (provenance?.origin === 'element-portrait') {
    return (
      <div className="material-editor__provenance">
        {t('materialEditor.provenance.formerPortrait', {
          name: elementName ?? t('topTimeline.untitled.element'),
        })}
      </div>
    );
  }
  return null;
}

/** Plain-text description of an image or PDF (`notes_json`). */
function MaterialDescription({ item, onUpdate }: { item: LibraryItem; onUpdate: UpdateMaterial }) {
  const { t } = useTranslation();
  const stored = extractTextFromCommentBody(item.notesJson);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? stored;
  return (
    <textarea
      className="material-editor__description"
      rows={Math.min(6, Math.max(1, value.split('\n').length))}
      value={value}
      placeholder={t('materialEditor.descriptionPlaceholder')}
      onFocus={() => setDraft(stored)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = (draft ?? stored).trim();
        setDraft(null);
        if (next !== stored.trim()) onUpdate({ notesJson: next ? createPlainCommentDoc(next) : null });
      }}
    />
  );
}

function MaterialMediaPage({ item, projectId, userId, onUpdate }: MaterialPageProps) {
  const { t } = useTranslation();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const zoomPan = useZoomPanSurface(surface, true);
  const isImage = item.kind === 'image';
  const imageSource = useStoredLibraryItemVariant(item, 'display', isImage);
  const pdfSource = useStoredLibraryItemVariant(item, 'source', item.kind === 'pdf');
  const asset = useDataStore((state) =>
    item.kind === 'image' || item.kind === 'pdf'
      ? state.projectAssets.find((candidate) => candidate.id === item.assetId) ?? null
      : null,
  );

  const stage = isImage ? (
    imageSource.fileUrl ? (
      <ImageMediaStage
        src={imageSource.fileUrl}
        naturalWidth={asset?.width ?? null}
        naturalHeight={asset?.height ?? null}
        viewport={zoomPan.viewport}
      />
    ) : (
      <MediaStageMessage
        message={imageSource.loading ? t('memoMaterial.preview.loading') : t('memoMaterial.preview.noImage')}
      />
    )
  ) : pdfSource.filePath ? (
    <PdfMediaStage key={pdfSource.filePath} filePath={pdfSource.filePath} viewport={zoomPan.viewport} />
  ) : (
    <MediaStageMessage
      message={pdfSource.loading ? t('memoMaterial.preview.loadingPdf') : t('memoMaterial.preview.noPdf')}
    />
  );

  return (
    <div className="material-editor__media-page">
      <header className="material-editor__header">
        <MaterialTitle item={item} onUpdate={onUpdate} />
        <MaterialProvenanceLine item={item} />
        <MaterialDescription item={item} onUpdate={onUpdate} />
        <MaterialRelations item={item} projectId={projectId} userId={userId} />
      </header>
      <div
        ref={setSurface}
        className="material-stage material-stage--tab"
        data-dragging={zoomPan.dragging ? 'true' : undefined}
        data-zoomed={zoomPan.viewport.scale > 1 ? 'true' : undefined}
        onDoubleClick={() => zoomPan.reset()}
        {...zoomPan.pointerHandlers}
      >
        {stage}
        <div className="material-stage__tools" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" title={t('materialEditor.zoomOut')} onClick={() => zoomPan.zoomBy(1 / 1.25)}>
            <Minus size={13} />
          </button>
          <button type="button" title={t('materialEditor.zoomReset')} onClick={() => zoomPan.reset()}>
            {Math.round(zoomPan.viewport.scale * 100)}%
          </button>
          <button type="button" title={t('materialEditor.zoomIn')} onClick={() => zoomPan.zoomBy(1.25)}>
            <Plus size={13} />
          </button>
          <button type="button" title={t('memoMaterial.preview.fullscreen')} onClick={() => setLightboxOpen(true)}>
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      {lightboxOpen && <LibraryItemFullscreenPreview material={item} onClose={() => setLightboxOpen(false)} />}
    </div>
  );
}
