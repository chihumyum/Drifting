import { useSidebarPanelState } from '../../hooks/useSidebarPanelState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { useAuthStore } from '../../store/auth';
import { useLibraryItem } from '../../usecase/useLibraryItem';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import type { LibraryItem } from '../../domain/library-item';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { ScopeToggle } from '../../components/ui/ScopeToggle';
import { ComposeLibraryItemDialog } from './LibraryDialogs';
import { openLibraryItemInSystem } from './open-library-item';
import { MaterialFolderTree, type MaterialTreeSelection } from './MaterialFolderTree';
import { MaterialFolderPicker } from './MaterialFolderPicker';
import { isDescendantFolder } from '../../domain/material-folder';
import { useMaterialFolder } from '../../usecase/useMaterialFolder';

export interface FocusedEntity {
  kind: EntityKind | null;
  id: string | null;
}

interface Props {
  /** The currently-focused entity (for the "仅当前条目相关" filter mode). */
  focused: FocusedEntity;
  /** The material in the active workspace tab, highlighted in the list. */
  activeLibraryItemId?: string | null;
  /** Double-click: open the material and keep its tab, as a double-clicked
   *  chapter does. The desktop shell owns tab promotion. */
  onPinLibraryItem?: (libraryItemId: string) => void;
  presentation?: 'desktop' | 'mobile';
  /** Opens the full TODO & Materials view; the desktop shell supplies it. */
  onOpenWorkbench?: () => void;
}

type ViewFilter = 'all' | 'related';

/**
 * Right-sidebar Library panel: the materials (images, PDFs and notes) in the
 * author's folders (MaterialFolderTree). Activating a material opens it as a
 * workspace tab; the context menu can still hand an image/PDF to the OS
 * default app.
 *
 * The `related` filter narrows the tree to items whose entity_relation row
 * points at `focused`.
 *
 * TODOs and comments live in the sibling ReviewPanel, not here.
 */
export function LibraryPanel({
  focused,
  activeLibraryItemId = null,
  onPinLibraryItem,
  onOpenWorkbench,
  presentation = 'desktop',
}: Props) {
  const { t } = useTranslation();
  const navigator = useWorkspaceNavigator();
  const { projectId } = navigator;
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const libraryItems = useDataStore((s) => s.libraryItems);
  const entityRelations = useDataStore((s) => s.entityRelations);
  const genericRelationTypeId = genericAssociationRelationTypeId(projectId);
  const genericRelations = useMemo(
    () =>
      entityRelations.filter(
        (relation) => relation.relationTypeId === genericRelationTypeId,
      ),
    [entityRelations, genericRelationTypeId],
  );
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [filter, setFilter] = useSidebarPanelState<ViewFilter>('filter', 'all');
  const [composeOpen, setComposeOpen] = useState(false);
  // The folder new materials are filed into (on mobile, the folder being shown).
  const [currentFolderId, setCurrentFolderId] = useSidebarPanelState<string | null>('currentFolder', null);
  const [moveRequest, setMoveRequest] = useState<{ selection: MaterialTreeSelection; current: string | null } | null>(null);
  const [newFolderRequest, setNewFolderRequest] = useState(0);
  const materialFolders = useDataStore((s) => s.materialFolders);
  const folderUsecases = useMaterialFolder(projectId);

  // Index entityRelations by from-entity so cards can render their relation
  // chips and the filter can pick out items related to `focused`.
  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof genericRelations>();
    genericRelations.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [genericRelations]);

  const isRelatedToFocus = useCallback(
    (kind: EntityKind, id: string) => {
      if (!focused.kind || !focused.id) return true;
      const refs = refsByFrom.get(`${kind}:${id}`) ?? [];
      return refs.some((r) => r.toKind === focused.kind && r.toId === focused.id);
    },
    [refsByFrom, focused.kind, focused.id],
  );

  const filteredLibraryItems = useMemo(() => {
    return libraryItems.filter(
      (mat) => filter !== 'related' || isRelatedToFocus('library_item', mat.id),
    );
  }, [libraryItems, filter, isRelatedToFocus]);

  const openLibraryItem = (m: LibraryItem) => {
    void openLibraryItemInSystem(projectId, m).then((result) => {
      if (!result.ok) alert(t('memoMaterial.error.openFile', { error: result.error }));
    });
  };

  // Every material opens as a workspace tab (a paper on mobile).
  const openLibraryItemInApp = (m: LibraryItem) => {
    navigator.open({ entityType: 'library_item', id: m.id });
  };

  const removeItems = async (removing: readonly LibraryItem[]) => {
    for (const item of removing) await libraryItemUsecases.removeLibraryItem(item.id);
  };

  // A folder cannot move into itself or anything below it.
  const blockedFolderIds = useMemo(() => {
    const moving = moveRequest?.selection.folderIds ?? [];
    return new Set(
      materialFolders
        .filter((folder) => moving.some((id) => isDescendantFolder(materialFolders, folder.id, id)))
        .map((folder) => folder.id),
    );
  }, [materialFolders, moveRequest]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        focusedKind={focused.kind}
        onCompose={() => setComposeOpen(true)}
        libraryItemTotal={libraryItems.length}
        onNewFolder={presentation === 'desktop' ? () => setNewFolderRequest((count) => count + 1) : undefined}
        onOpenWorkbench={onOpenWorkbench}
      />

      <div className="scroll-no-bar workspace-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <MaterialFolderTree
          projectId={projectId}
          items={filteredLibraryItems}
          narrowed={filter === 'related'}
          activeLibraryItemId={activeLibraryItemId}
          presentation={presentation}
          currentFolderId={currentFolderId}
          onCurrentFolderChange={setCurrentFolderId}
          onOpenItem={openLibraryItemInApp}
          onPinItem={onPinLibraryItem ? (m) => onPinLibraryItem(m.id) : undefined}
          onOpenInSystem={openLibraryItem}
          onRenameItem={(m, title) => void libraryItemUsecases.updateLibraryItem(m.id, { title })}
          onRemoveItems={removeItems}
          onMove={(selection, current) => setMoveRequest({ selection, current })}
          relationsOf={(id) => refsByFrom.get(`library_item:${id}`) ?? []}
          onAddRelation={(id, target) => relationUsecases.addGenericAssociation('library_item', id, target.kind, target.id)}
          onRemoveRelation={(id, target) => {
            const ref = genericRelations.find(
              (r) => r.fromKind === 'library_item' && r.fromId === id && r.toKind === target.kind && r.toId === target.id,
            );
            if (ref) relationUsecases.removeRelation(ref.id);
          }}
          newFolderRequest={newFolderRequest}
        />
      </div>

      {moveRequest && (
        <MaterialFolderPicker
          projectId={projectId}
          currentFolderId={moveRequest.current}
          disabledFolderIds={blockedFolderIds}
          onClose={() => setMoveRequest(null)}
          onPick={(folderId) => {
            const { itemIds, folderIds } = moveRequest.selection;
            setMoveRequest(null);
            void (async () => {
              if (itemIds.length > 0) await folderUsecases.moveMaterialsToFolder(itemIds, folderId);
              for (const id of folderIds) await folderUsecases.moveFolder(id, folderId);
            })().catch((error: unknown) => console.warn('[material] failed to move materials:', error));
          }}
        />
      )}

      {composeOpen && (
        <ComposeLibraryItemDialog
          focused={focused}
          onCancel={() => setComposeOpen(false)}
          onCreate={async (input, relations) => {
            // A new material is filed where the author is looking.
            const mat = await libraryItemUsecases.createLibraryItem({
              ...input,
              folderId: materialFolders.some((folder) => folder.id === currentFolderId) ? currentFolderId : null,
            });
            // A new note is opened for writing; images and PDFs stay in the list.
            if (mat.kind === 'text') navigator.open({ entityType: 'library_item', id: mat.id }, { preview: false });
            const relationResults = await Promise.allSettled(
              relations.map((t) =>
                relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id),
              ),
            );
            const failedRelations = relationResults.filter(
              (result) => result.status === 'rejected',
            );
            if (failedRelations.length > 0) {
              console.warn(
                '[material] material created, but some relations failed:',
                failedRelations,
              );
            }
          }}
        />
      )}

    </div>
  );
}


function Toolbar({
  filter,
  onFilterChange,
  focusedKind,
  onCompose,
  libraryItemTotal,
  onNewFolder,
  onOpenWorkbench,
}: {
  /** Desktop: a new folder in the current one. */
  onNewFolder?: () => void;
  /** Desktop: opens the full TODO & Materials view from beside the materials. */
  onOpenWorkbench?: () => void;
  filter: ViewFilter;
  onFilterChange: (f: ViewFilter) => void;
  focusedKind: EntityKind | null;
  onCompose: () => void;
  libraryItemTotal: number;
}) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // In a narrow pane the material count goes first (~ 230px); the scope
  // toggle's one word needs no shorter form.
  const [showCount, setShowCount] = useState(true);
  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const update = () => {
      setShowCount(node.clientWidth >= 230);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={toolbarRef}
      className="workspace-panel-header-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        flexShrink: 0,
        // Pin the toolbar to the top of the scroll container so the filter
        // chips + "+" button don't slide away when the cards list scrolls.
        position: 'sticky',
        top: 0,
        zIndex: 4,
        background: 'var(--workspace-ui-bg)',
      }}
    >
      {/* Two states, so one toggle: off shows every material, on only those
          related to the focused chapter, element or material. */}
      <ScopeToggle
        pressed={filter === 'related' && Boolean(focusedKind)}
        disabled={!focusedKind}
        onToggle={() => onFilterChange(filter === 'related' ? 'all' : 'related')}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--ui-font-caption, 9.5px)',
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.08em',
        }}
      >
        {showCount && <span>{t('memoMaterial.toolbar.count', { count: libraryItemTotal })}</span>}
        {onOpenWorkbench && (
          <GhostIconButton
            glass="round"
            className="workspace-super-view-entry"
            title={t('bottomStatusBar.todoLibrary')}
            aria-label={t('bottomStatusBar.todoLibrary')}
            onClick={onOpenWorkbench}
            icon={<BrushIcon name="lib-curio" />}
          />
        )}
        {onNewFolder && (
          <GhostIconButton
            size="sm"
            title={t('materialFolders.menu.newFolder')}
            aria-label={t('materialFolders.menu.newFolder')}
            onClick={onNewFolder}
            icon={<BrushIcon name="folder-plus" size={12} />}
          />
        )}
        <GhostIconButton
          size="sm"
          title={t('memoMaterial.toolbar.newMaterial')}
          aria-label={t('memoMaterial.toolbar.newMaterial')}
          onClick={onCompose}
          icon={<BrushIcon name="plus" size={12} />}
        />
      </div>
    </div>
  );
}
