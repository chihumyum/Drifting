import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Maximize2, MessageSquarePlus, Minus, Plus } from 'lucide-react';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { requestConfirmation } from '../store/confirmation-store';
import { useCanPromoteOnEdit, usePromoteCurrentTab, useUiStore } from '../store/ui-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useEntityStickyNoteRail } from '../hooks/useEntityStickyNoteRail';
import { useLibraryItem } from '../usecase/useLibraryItem';
import { useEntityRelations } from '../usecase/useEntityRelations';
import { genericAssociationRelationTypeId } from '../domain/entity-relation-type';
import type { LibraryItem } from '../domain/library-item';
import { createPlainCommentDoc, extractTextFromCommentBody, parseMaterialRegion, type MaterialRegion } from '../domain/comment';
import { parseMaterialProvenance } from '../domain/material-provenance';
import {
  EditorCrumb,
  EditorTopBar,
  MATERIAL_MOVE_TO_FOLDER_ACTION,
  MATERIAL_OPEN_IN_SYSTEM_ACTION,
  NOTE_TASK_TODOS_OFF_ACTION,
  NOTE_TASK_TODOS_ON_ACTION,
} from '../components/editor/EditorTopBar';
import { MaterialFolderPicker } from '../features/library/MaterialFolderPicker';
import { materialFolderPath } from '../domain/material-folder';
import { useMaterialFolder } from '../usecase/useMaterialFolder';
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
  type MediaBox,
} from '../features/library/MaterialMediaStage';
import { MaterialRegionLayer, RegionCommentComposer, type RegionMark } from '../features/library/MaterialRegionLayer';
import { ReviewItemCard } from '../features/comments/ReviewItemCard';
import { useComment } from '../usecase/useComment';
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
  // Media keeps its own comment column; notes use the shared margin rail.
  const noteComments = useEntityStickyNoteRail('library_item', isMedia ? null : libraryItemId);
  const materialFolders = useDataStore((state) => state.materialFolders);
  const folderUsecases = useMaterialFolder(projectId);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

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
      if (action === MATERIAL_MOVE_TO_FOLDER_ACTION) {
        setFolderPickerOpen(true);
        return;
      }
      if (action === NOTE_TASK_TODOS_OFF_ACTION || action === NOTE_TASK_TODOS_ON_ACTION) {
        update({ taskTodos: action === NOTE_TASK_TODOS_ON_ACTION });
        return;
      }
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
    [item, leaveDeletedEntity, libraryItemUsecases, projectId, t, update],
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
        outlineToggle={!isMedia}
        commentToggle={
          isMedia
            ? undefined
            : {
                enabled: noteComments.visible,
                count: noteComments.itemIds.length,
                onToggle: () => noteComments.setVisible(!noteComments.visible),
              }
        }
        hiddenMenuActions={
          isMedia
            ? [NOTE_TASK_TODOS_OFF_ACTION, NOTE_TASK_TODOS_ON_ACTION]
            : [MATERIAL_OPEN_IN_SYSTEM_ACTION, item.taskTodos ? NOTE_TASK_TODOS_ON_ACTION : NOTE_TASK_TODOS_OFF_ACTION]
        }
      >
        <EditorCrumb>{t('materialEditor.crumb')}</EditorCrumb>
        {materialFolderPath(materialFolders, item.folderId).map((folder) => (
          <EditorCrumb key={folder.id}>{folder.name}</EditorCrumb>
        ))}
        <EditorCrumb>{kindLabel}</EditorCrumb>
      </EditorTopBar>
      {folderPickerOpen && (
        <MaterialFolderPicker
          projectId={projectId}
          currentFolderId={item.folderId}
          onClose={() => setFolderPickerOpen(false)}
          onPick={(folderId) => {
            setFolderPickerOpen(false);
            void folderUsecases
              .moveMaterialsToFolder([item.id], folderId)
              .catch((error: unknown) => log.error('Failed to move material:', error));
          }}
        />
      )}
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

type UpdateMaterial = (patch: { title?: string; notesJson?: string | null; taskTodos?: boolean }) => void;

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
  const [drawing, setDrawing] = useState(false);
  const [pending, setPending] = useState<{ rect: Pick<MaterialRegion, 'x' | 'y' | 'w' | 'h'>; page: number | null; screen: { x: number; y: number } } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const zoomPan = useZoomPanSurface(surface, true);
  const isImage = item.kind === 'image';
  const imageSource = useStoredLibraryItemVariant(item, 'display', isImage);
  const pdfSource = useStoredLibraryItemVariant(item, 'source', item.kind === 'pdf');
  const asset = useDataStore((state) =>
    item.kind === 'image' || item.kind === 'pdf'
      ? state.projectAssets.find((candidate) => candidate.id === item.assetId) ?? null
      : null,
  );
  const allComments = useDataStore((state) => state.comments);
  const commentUsecases = useComment({ projectId, userId });

  // Region comments first in reading order (page, then top to bottom); whole-
  // material comments without a region follow.
  const comments = useMemo(() => {
    const mine = allComments
      .filter((comment) => comment.targetKind === 'library_item' && comment.targetId === item.id && comment.status !== 'converted')
      .map((comment) => ({ comment, region: parseMaterialRegion(comment.anchorJson) }));
    const order = (entry: (typeof mine)[number]) =>
      entry.region ? (entry.region.page ?? 1) * 10 + entry.region.y : Number.POSITIVE_INFINITY;
    return mine.sort((a, b) => order(a) - order(b) || a.comment.createdAt.localeCompare(b.comment.createdAt));
  }, [allComments, item.id]);
  const marks = useMemo<RegionMark[]>(
    () =>
      comments.flatMap(({ comment, region }, index) =>
        region
          ? [{ id: comment.id, index: index + 1, region, resolved: comment.status === 'resolved', todo: comment.kind === 'todo' }]
          : [],
      ),
    [comments],
  );

  const selectComment = (id: string) => {
    setSelectedId(id);
    const page = comments.find((entry) => entry.comment.id === id)?.region?.page;
    if (page) setPdfPage(page);
    document.getElementById(`material-comment-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const createRegionComment = async (body: string, asTodo: boolean) => {
    if (!pending) return;
    const region: MaterialRegion = { v: 1, ...(pending.page ? { page: pending.page } : {}), ...pending.rect };
    setPending(null);
    setDrawing(false);
    try {
      const created = await commentUsecases.createComment({
        kind: asTodo ? 'todo' : 'note',
        targetKind: 'library_item',
        targetId: item.id,
        anchorJson: JSON.stringify({ region, createdAt: new Date().toISOString() }),
        bodyJson: createPlainCommentDoc(body),
      });
      setSelectedId(created.id);
    } catch (error) {
      log.error('Failed to create region comment:', error);
      alert(t('materialEditor.regions.createFailed'));
    }
  };

  const overlay = (box: MediaBox) => (
    <MaterialRegionLayer
      box={box}
      marks={marks}
      selectedId={selectedId}
      drawing={drawing}
      onSelect={selectComment}
      onDrawn={(rect, screen) => setPending({ rect, page: box.page, screen })}
    />
  );

  const stage = isImage ? (
    imageSource.fileUrl ? (
      <ImageMediaStage
        src={imageSource.fileUrl}
        naturalWidth={asset?.width ?? null}
        naturalHeight={asset?.height ?? null}
        viewport={zoomPan.viewport}
        overlay={overlay}
      />
    ) : (
      <MediaStageMessage
        message={imageSource.loading ? t('memoMaterial.preview.loading') : t('memoMaterial.preview.noImage')}
      />
    )
  ) : pdfSource.filePath ? (
    <PdfMediaStage
      key={pdfSource.filePath}
      filePath={pdfSource.filePath}
      viewport={zoomPan.viewport}
      overlay={overlay}
      page={pdfPage}
      onPageChange={setPdfPage}
    />
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
      <div className="material-editor__media-body">
        <div
          ref={setSurface}
          className="material-stage material-stage--tab"
          data-dragging={zoomPan.dragging ? 'true' : undefined}
          data-zoomed={zoomPan.viewport.scale > 1 ? 'true' : undefined}
          data-drawing={drawing ? 'true' : undefined}
          onDoubleClick={() => {
            if (!drawing) zoomPan.reset();
          }}
          {...zoomPan.pointerHandlers}
        >
          {stage}
          <div className="material-stage__tools" onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={drawing ? 'is-active' : undefined}
              aria-pressed={drawing}
              title={drawing ? t('materialEditor.regions.stopDrawing') : t('materialEditor.regions.draw')}
              onClick={() => {
                setDrawing((value) => !value);
                setPending(null);
              }}
            >
              <MessageSquarePlus size={13} />
            </button>
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
          {drawing && <div className="material-stage__hint">{t('materialEditor.regions.drawHint')}</div>}
        </div>
        {(comments.length > 0 || drawing) && (
          <aside className="material-comments" aria-label={t('materialEditor.regions.listLabel')}>
            {comments.length === 0 ? (
              <div className="material-comments__empty">{t('materialEditor.regions.empty')}</div>
            ) : (
              comments.map(({ comment, region }, index) => (
                <div
                  key={comment.id}
                  id={`material-comment-${comment.id}`}
                  className={`material-comments__item${comment.id === selectedId ? ' material-comments__item--selected' : ''}`}
                  onClickCapture={() => selectComment(comment.id)}
                >
                  <div className="material-comments__meta">
                    <span className="material-comments__index">{index + 1}</span>
                    {region?.page ? t('materialEditor.regions.page', { page: region.page }) : !region ? t('materialEditor.regions.whole') : null}
                  </div>
                  <ReviewItemCard comment={comment} projectId={projectId} presentation="panel" />
                </div>
              ))
            )}
          </aside>
        )}
      </div>
      {pending && (
        <RegionCommentComposer
          anchor={pending.screen}
          onSubmit={(body, asTodo) => void createRegionComment(body, asTodo)}
          onCancel={() => setPending(null)}
        />
      )}
      {lightboxOpen && <LibraryItemFullscreenPreview material={item} onClose={() => setLightboxOpen(false)} />}
    </div>
  );
}
