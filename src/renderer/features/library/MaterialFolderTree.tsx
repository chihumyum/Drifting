import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText, Folder, FolderOpen, FolderPlus, MoreHorizontal } from 'lucide-react';

import type { LibraryItem } from '../../domain/library-item';
import { extractTextFromCommentBody } from '../../domain/comment';
import {
  buildMaterialFolderChildren,
  effectiveMaterialFolderId,
  materialFolderPath,
  ROOT_FOLDER_KEY,
  type MaterialFolder,
} from '../../domain/material-folder';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { useDataStore } from '../../store/data-store';
import { requestConfirmation } from '../../store/confirmation-store';
import { useSidebarPanelState } from '../../hooks/useSidebarPanelState';
import { useMaterialFolder } from '../../usecase/useMaterialFolder';
import { ContextMenuSurface } from '../../components/ui/ContextMenuSurface';
import { KindMark } from '../../components/ui/KindMark';
import { EmptyState } from '../../components/ui/EmptyState';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { NoteExcerpt } from './NoteExcerpt';
import { useStoredLibraryItemVariant } from './library-item-media';

const MATERIAL_DRAG = 'application/x-drifting-material';
const FOLDER_DRAG = 'application/x-drifting-material-folder';

/** A material and folder selection, as the panel moves it. */
export interface MaterialTreeSelection {
  itemIds: string[];
  folderIds: string[];
}

type Entry =
  | { key: string; depth: number; kind: 'folder'; folder: MaterialFolder; open: boolean; disclosure: boolean }
  | { key: string; depth: number; kind: 'item'; item: LibraryItem };

type MenuTarget =
  | { kind: 'root' }
  | { kind: 'selection'; selection: MaterialTreeSelection }
  | { kind: 'folder'; folder: MaterialFolder }
  | { kind: 'item'; item: LibraryItem };

export interface MaterialFolderTreeProps {
  projectId: string;
  /** The materials the panel shows (after its "related" filter). */
  items: readonly LibraryItem[];
  /** Hide folders holding none of `items` (a filter is narrowing the list). */
  narrowed: boolean;
  activeLibraryItemId: string | null;
  presentation: 'desktop' | 'mobile';
  /** The folder new materials go into; on mobile, the folder being shown. */
  currentFolderId: string | null;
  onCurrentFolderChange: (folderId: string | null) => void;
  onOpenItem: (item: LibraryItem) => void;
  onPinItem?: (item: LibraryItem) => void;
  onOpenInSystem: (item: LibraryItem) => void;
  onRenameItem: (item: LibraryItem, title: string) => void;
  /** Deletes materials the tree has already confirmed. */
  onRemoveItems: (items: readonly LibraryItem[]) => Promise<void>;
  /** Opens the folder picker for a selection. */
  onMove: (selection: MaterialTreeSelection, currentFolderId: string | null) => void;
  relationsOf: (libraryItemId: string) => { id: string; toKind: EntityKind; toId: string }[];
  onAddRelation: (libraryItemId: string, target: RelationTarget) => void;
  onRemoveRelation: (libraryItemId: string, target: RelationTarget) => void;
  /** Bumped by the panel toolbar: create a folder in the current one and name it. */
  newFolderRequest?: number;
}

const folderKey = (id: string) => `f:${id}`;
const itemKey = (id: string) => `i:${id}`;

function selectionOf(keys: readonly string[]): MaterialTreeSelection {
  return {
    itemIds: keys.filter((key) => key.startsWith('i:')).map((key) => key.slice(2)),
    folderIds: keys.filter((key) => key.startsWith('f:')).map((key) => key.slice(2)),
  };
}

function compareItems(a: LibraryItem, b: LibraryItem): number {
  if (!a.title !== !b.title) return a.title ? -1 : 1;
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);
}

/**
 * The material panel: a Finder-style tree of user folders with the materials
 * in them. The root has no row of its own. Folders are thin rows; materials
 * are taller cells with a preview (a thumbnail, or a note's first lines) that
 * expand to the full preview. Collapsing a folder is the compact view.
 *
 * Desktop: click opens (a folder toggles), ⌘-click and ⇧-click select several
 * materials and folders, ⌥-click a folder opens or closes everything inside,
 * drag a selection onto a folder (or the empty area for the root), right-click
 * to create, rename, move or delete. Mobile shows one folder at a time under a
 * breadcrumb.
 */
export function MaterialFolderTree(props: MaterialFolderTreeProps) {
  const { t } = useTranslation();
  const { projectId, items, narrowed, presentation, currentFolderId, onCurrentFolderChange } = props;
  const desktop = presentation === 'desktop';
  const folders = useDataStore((state) => state.materialFolders);
  const folderUsecases = useMaterialFolder(projectId);
  const [expanded, setExpanded] = useSidebarPanelState<string[]>('expandedFolders', []);
  const [previewed, setPreviewed] = useSidebarPanelState<string[]>('expandedMaterials', []);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [relationPickerFor, setRelationPickerFor] = useState<string | null>(null);

  const children = useMemo(() => buildMaterialFolderChildren(folders), [folders]);
  const itemsByFolder = useMemo(() => {
    const ids = new Set(folders.map((folder) => folder.id));
    const map = new Map<string, LibraryItem[]>();
    for (const item of items) {
      const key = effectiveMaterialFolderId(ids, item.folderId) ?? ROOT_FOLDER_KEY;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    for (const list of map.values()) list.sort(compareItems);
    return map;
  }, [folders, items]);
  // Materials anywhere below each folder, for counts and the narrowed view.
  const totals = useMemo(() => {
    const totalsByFolder = new Map<string, number>();
    const count = (key: string): number => {
      let total = itemsByFolder.get(key)?.length ?? 0;
      for (const child of children.get(key) ?? []) total += count(child.id);
      if (key !== ROOT_FOLDER_KEY) totalsByFolder.set(key, total);
      return total;
    };
    count(ROOT_FOLDER_KEY);
    return totalsByFolder;
  }, [children, itemsByFolder]);

  const isExpanded = (id: string) => expanded.includes(id);
  const setFolderExpanded = (id: string, open: boolean) =>
    setExpanded(open ? [...new Set([...expanded, id])] : expanded.filter((candidate) => candidate !== id));
  const subtreeIds = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap((child) => subtreeIds(child.id))];
  const setSubtreeExpanded = (id: string, open: boolean) => {
    const ids = new Set(subtreeIds(id));
    setExpanded(open ? [...new Set([...expanded, ...ids])] : expanded.filter((candidate) => !ids.has(candidate)));
  };
  const setPreviewOpen = (id: string, open: boolean) =>
    setPreviewed(open ? [...new Set([...previewed, id])] : previewed.filter((candidate) => candidate !== id));

  const newFolder = async (parentFolderId: string | null) => {
    const folder = await folderUsecases.createFolder({ name: t('materialFolders.untitled'), parentFolderId });
    if (parentFolderId) setFolderExpanded(parentFolderId, true);
    setRenamingKey(folderKey(folder.id));
  };
  const handledNewFolderRequest = useRef(props.newFolderRequest ?? 0);
  useEffect(() => {
    const request = props.newFolderRequest ?? 0;
    if (request === handledNewFolderRequest.current) return;
    handledNewFolderRequest.current = request;
    const parent = currentFolderId !== null && folders.some((folder) => folder.id === currentFolderId) ? currentFolderId : null;
    void newFolder(parent).catch((error: unknown) => console.warn('[material] failed to create a folder:', error));
    // Only a new request creates a folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.newFolderRequest]);

  const removeSelection = async ({ itemIds, folderIds }: MaterialTreeSelection) => {
    const removing = items.filter((item) => itemIds.includes(item.id));
    const removingFolders = folders.filter((folder) => folderIds.includes(folder.id));
    const count = removing.length + removingFolders.length;
    if (count === 0) return;
    const message =
      count > 1
        ? t('materialFolders.deleteSelectionConfirm', { count })
        : removingFolders[0]
          ? t('materialFolders.deleteConfirm', { name: removingFolders[0].name })
          : t('materialEditor.deleteConfirm', { title: removing[0]?.title || t('common.untitled') });
    if (!(await requestConfirmation(message))) return;
    // Materials first: a deleted folder hands what is left in it to its parent.
    await props.onRemoveItems(removing);
    for (const folder of removingFolders) await folderUsecases.deleteFolder(folder.id);
    if (currentFolderId && folderIds.includes(currentFolderId)) onCurrentFolderChange(null);
    setSelected([]);
  };

  const mobileKey = currentFolderId !== null && folders.some((folder) => folder.id === currentFolderId) ? currentFolderId : ROOT_FOLDER_KEY;
  const visibleFolders = (key: string) =>
    (children.get(key) ?? []).filter((folder) => !narrowed || (totals.get(folder.id) ?? 0) > 0);
  const desktopEntries = (key: string, depth: number): Entry[] => [
    ...visibleFolders(key).flatMap((folder): Entry[] => {
      const open = isExpanded(folder.id);
      const row: Entry = { key: folderKey(folder.id), depth, kind: 'folder', folder, open, disclosure: true };
      return open ? [row, ...desktopEntries(folder.id, depth + 1)] : [row];
    }),
    ...(itemsByFolder.get(key) ?? []).map((item): Entry => ({ key: itemKey(item.id), depth, kind: 'item', item })),
  ];
  const entries: Entry[] = desktop
    ? desktopEntries(ROOT_FOLDER_KEY, 0)
    : [
        ...visibleFolders(mobileKey).map((folder): Entry => ({
          key: folderKey(folder.id),
          depth: 0,
          kind: 'folder',
          folder,
          open: false,
          disclosure: false,
        })),
        ...(itemsByFolder.get(mobileKey) ?? []).map((item): Entry => ({ key: itemKey(item.id), depth: 0, kind: 'item', item })),
      ];

  /** Applies ⌘/⇧ selection; returns true for a plain click, which also acts. */
  const selectOnClick = (entry: Entry, event: MouseEvent): boolean => {
    if (desktop && (event.metaKey || event.ctrlKey)) {
      setSelected((current) =>
        current.includes(entry.key) ? current.filter((key) => key !== entry.key) : [...current, entry.key],
      );
      setAnchor(entry.key);
      return false;
    }
    if (desktop && event.shiftKey && anchor) {
      const keys = entries.map((candidate) => candidate.key);
      const from = keys.indexOf(anchor);
      const to = keys.indexOf(entry.key);
      if (from >= 0 && to >= 0) {
        setSelected(keys.slice(Math.min(from, to), Math.max(from, to) + 1));
        return false;
      }
    }
    setSelected([entry.key]);
    setAnchor(entry.key);
    return true;
  };

  const dragged = (entry: Entry) => selectionOf(selected.includes(entry.key) ? selected : [entry.key]);
  const startDrag = (event: DragEvent, entry: Entry) => {
    const { itemIds, folderIds } = dragged(entry);
    if (itemIds.length > 0) event.dataTransfer.setData(MATERIAL_DRAG, itemIds.join(','));
    if (folderIds.length > 0) event.dataTransfer.setData(FOLDER_DRAG, folderIds.join(','));
    event.dataTransfer.effectAllowed = 'move';
  };
  const acceptsDrop = (event: DragEvent) =>
    event.dataTransfer.types.includes(MATERIAL_DRAG) || event.dataTransfer.types.includes(FOLDER_DRAG);
  const dropInto = (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropKey(null);
    const itemIds = event.dataTransfer.getData(MATERIAL_DRAG).split(',').filter(Boolean);
    const folderIds = event.dataTransfer.getData(FOLDER_DRAG).split(',').filter(Boolean);
    if (itemIds.length > 0) void folderUsecases.moveMaterialsToFolder(itemIds, folderId);
    // A folder dropped into itself or below itself stays where it is.
    for (const id of folderIds) if (id !== folderId) void folderUsecases.moveFolder(id, folderId);
    if (folderId) setFolderExpanded(folderId, true);
  };
  const dropZone = (key: string, folderId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!acceptsDrop(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (dropKey === key) setDropKey(null);
    },
    onDrop: (event: DragEvent) => dropInto(event, folderId),
  });

  const openMenu = (event: MouseEvent, entry: Entry | null) => {
    event.preventDefault();
    event.stopPropagation();
    let target: MenuTarget = { kind: 'root' };
    if (entry && selected.length > 1 && selected.includes(entry.key)) target = { kind: 'selection', selection: selectionOf(selected) };
    else if (entry?.kind === 'folder') target = { kind: 'folder', folder: entry.folder };
    else if (entry?.kind === 'item') target = { kind: 'item', item: entry.item };
    if (entry && !selected.includes(entry.key)) {
      setSelected([entry.key]);
      setAnchor(entry.key);
    }
    setMenu({ x: event.clientX, y: event.clientY, target });
  };

  const onTreeKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    if (event.key === 'Escape' && selected.length > 0) {
      event.preventDefault();
      setSelected([]);
    }
    if (desktop && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelected(entries.map((entry) => entry.key));
    }
  };

  const folderRow = (entry: Extract<Entry, { kind: 'folder' }>) => {
    const { folder, open, disclosure, depth } = entry;
    const isSelected = selected.includes(entry.key);
    const activate = (event: MouseEvent) => {
      if (desktop && event.altKey) {
        setSubtreeExpanded(folder.id, !open);
        return;
      }
      if (!selectOnClick(entry, event)) return;
      onCurrentFolderChange(folder.id);
      if (disclosure) setFolderExpanded(folder.id, !open);
    };
    return (
      <div
        key={entry.key}
        role="treeitem"
        aria-expanded={disclosure ? open : undefined}
        aria-selected={isSelected}
        tabIndex={0}
        className={`material-tree__row material-tree__row--folder${dropKey === folder.id ? ' material-tree__row--drop' : ''}${isSelected ? ' material-tree__row--selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={desktop && renamingKey !== entry.key}
        onDragStart={(event) => startDrag(event, entry)}
        {...dropZone(folder.id, folder.id)}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          onCurrentFolderChange(folder.id);
          if (disclosure) setFolderExpanded(folder.id, !open);
        }}
        onContextMenu={(event) => openMenu(event, entry)}
      >
        {disclosure ? (
          <ChevronRight
            size={11}
            strokeWidth={1.8}
            className={`material-tree__chevron${open ? ' material-tree__chevron--open' : ''}`}
            aria-hidden
          />
        ) : (
          <span className="material-tree__chevron-space" aria-hidden />
        )}
        {open && disclosure ? <FolderOpen size={13} strokeWidth={1.6} aria-hidden /> : <Folder size={13} strokeWidth={1.6} aria-hidden />}
        {renamingKey === entry.key ? (
          <NameInput
            initial={folder.name}
            onDone={(name) => {
              setRenamingKey(null);
              if (name !== null) void folderUsecases.renameFolder(folder.id, name);
            }}
          />
        ) : (
          <span className="material-tree__name">{folder.name}</span>
        )}
        <span className="material-tree__count">{totals.get(folder.id) ?? 0}</span>
        {!desktop && <MoreButton label={t('common.more')} onOpen={(event) => openMenu(event, entry)} />}
      </div>
    );
  };

  const itemRow = (entry: Extract<Entry, { kind: 'item' }>) => {
    const { item, depth } = entry;
    const active = item.id === props.activeLibraryItemId;
    const isSelected = selected.includes(entry.key);
    const previewOpen = previewed.includes(item.id);
    return (
      <div
        key={entry.key}
        role="treeitem"
        aria-selected={isSelected || active}
        tabIndex={0}
        className={`material-tree__row material-tree__row--item sand-cell${active ? ' material-tree__row--active is-selected' : ''}${isSelected ? ' material-tree__row--selected' : ''}`}
        style={{
          paddingLeft: 6 + depth * 14,
          '--cell-c': 'hsl(var(--ink-3))',
          '--cell-frame-origin': `${6 + depth * 14 + 7 + 2}px`,
        } as CSSProperties}
        draggable={desktop && renamingKey !== entry.key}
        onDragStart={(event) => startDrag(event, entry)}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('input, .material-tree__cell-extra')) return;
          if (selectOnClick(entry, event)) props.onOpenItem(item);
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('input, button, .material-tree__cell-extra')) return;
          props.onPinItem?.(item);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== 'Enter') return;
          props.onOpenItem(item);
        }}
        onContextMenu={(event) => openMenu(event, entry)}
      >
        {/* A material: one upright stroke, a slip of paper tucked into the book. */}
        <span className="material-tree__chevron-space" aria-hidden>
          <KindMark kind="material" color="hsl(var(--ink-3))" />
        </span>
        <MaterialCell
          item={item}
          renaming={renamingKey === entry.key}
          onRenamed={(title) => {
            setRenamingKey(null);
            if (title !== null && title !== item.title) props.onRenameItem(item, title);
          }}
          previewOpen={previewOpen}
          onTogglePreview={() => setPreviewOpen(item.id, !previewOpen)}
          relations={props.relationsOf(item.id)}
          relationPickerOpen={relationPickerFor === item.id}
          onRelationPickerOpenChange={(open) => setRelationPickerFor(open ? item.id : null)}
          onAddRelation={(target) => props.onAddRelation(item.id, target)}
          onRemoveRelation={(target) => props.onRemoveRelation(item.id, target)}
          onOpen={() => props.onOpenItem(item)}
        />
        {!desktop && <MoreButton label={t('common.more')} onOpen={(event) => openMenu(event, entry)} />}
        <i className="cell-ring" aria-hidden="true" />
        <i className="cell-frame" aria-hidden="true" />
      </div>
    );
  };

  const breadcrumb = materialFolderPath(folders, mobileKey === ROOT_FOLDER_KEY ? null : mobileKey);
  const menuTarget = menu?.target;
  const menuItems: Array<{ label: string; danger?: boolean; run: () => void }> = !menuTarget
    ? []
    : menuTarget.kind === 'root'
      ? [{ label: t('materialFolders.menu.newFolder'), run: () => void newFolder(null) }]
      : menuTarget.kind === 'selection'
        ? [
            {
              label: t('materialFolders.menu.moveSelection', {
                count: menuTarget.selection.itemIds.length + menuTarget.selection.folderIds.length,
              }),
              run: () => props.onMove(menuTarget.selection, null),
            },
            {
              label: t('materialFolders.menu.deleteSelection', {
                count: menuTarget.selection.itemIds.length + menuTarget.selection.folderIds.length,
              }),
              danger: true,
              run: () => void removeSelection(menuTarget.selection),
            },
          ]
        : menuTarget.kind === 'folder'
          ? [
              { label: t('materialFolders.menu.newSubfolder'), run: () => void newFolder(menuTarget.folder.id) },
              ...((children.get(menuTarget.folder.id) ?? []).length > 0
                ? [
                    { label: t('materialFolders.menu.expandAll'), run: () => setSubtreeExpanded(menuTarget.folder.id, true) },
                    { label: t('materialFolders.menu.collapseAll'), run: () => setSubtreeExpanded(menuTarget.folder.id, false) },
                  ]
                : []),
              { label: t('materialFolders.menu.rename'), run: () => setRenamingKey(folderKey(menuTarget.folder.id)) },
              {
                label: t('materialFolders.menu.move'),
                run: () => props.onMove({ itemIds: [], folderIds: [menuTarget.folder.id] }, menuTarget.folder.parentFolderId),
              },
              {
                label: t('materialFolders.menu.delete'),
                danger: true,
                run: () => void removeSelection({ itemIds: [], folderIds: [menuTarget.folder.id] }),
              },
            ]
          : [
              { label: t('materialFolders.menu.open'), run: () => props.onOpenItem(menuTarget.item) },
              {
                label: previewed.includes(menuTarget.item.id)
                  ? t('materialFolders.menu.collapsePreview')
                  : t('materialFolders.menu.expandPreview'),
                run: () => setPreviewOpen(menuTarget.item.id, !previewed.includes(menuTarget.item.id)),
              },
              { label: t('materialFolders.menu.rename'), run: () => setRenamingKey(itemKey(menuTarget.item.id)) },
              {
                label: t('memoMaterial.menu.addRelation'),
                run: () => {
                  setPreviewOpen(menuTarget.item.id, true);
                  setRelationPickerFor(menuTarget.item.id);
                },
              },
              {
                label: t('materialFolders.menu.move'),
                run: () => props.onMove({ itemIds: [menuTarget.item.id], folderIds: [] }, menuTarget.item.folderId),
              },
              ...(menuTarget.item.kind === 'text'
                ? []
                : [{ label: t('memoMaterial.menu.openInSystem'), run: () => props.onOpenInSystem(menuTarget.item) }]),
              {
                label: t('memoMaterial.menu.deleteMaterial'),
                danger: true,
                run: () => void removeSelection({ itemIds: [menuTarget.item.id], folderIds: [] }),
              },
            ];

  const rows: ReactNode[] = entries.map((entry) => (entry.kind === 'folder' ? folderRow(entry) : itemRow(entry)));

  return (
    <div className="material-tree">
      {!desktop && (
        <nav className="material-tree__breadcrumb" aria-label={t('materialFolders.breadcrumb')}>
          <button type="button" onClick={() => onCurrentFolderChange(null)}>
            {t('materialFolders.root')}
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id}>
              <ChevronRight size={10} strokeWidth={1.8} aria-hidden />
              <button type="button" onClick={() => onCurrentFolderChange(folder.id)}>
                {folder.name}
              </button>
            </span>
          ))}
          <button
            type="button"
            className="material-tree__breadcrumb-new"
            title={t('materialFolders.menu.newFolder')}
            aria-label={t('materialFolders.menu.newFolder')}
            onClick={() => void newFolder(mobileKey === ROOT_FOLDER_KEY ? null : mobileKey)}
          >
            <FolderPlus size={13} strokeWidth={1.6} />
          </button>
        </nav>
      )}
      <div
        role="tree"
        aria-label={t('materialFolders.tree')}
        aria-multiselectable={desktop}
        className={`material-tree__rows${dropKey === ROOT_FOLDER_KEY ? ' material-tree__rows--drop' : ''}`}
        {...dropZone(ROOT_FOLDER_KEY, null)}
        onKeyDown={onTreeKeyDown}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          setSelected([]);
          onCurrentFolderChange(null);
        }}
        onContextMenu={(event) => openMenu(event, null)}
      >
        {rows.length === 0 ? (
          <EmptyState density="compact" message={t(narrowed ? 'memoMaterial.empty.noRelated' : 'materialFolders.empty')} />
        ) : (
          rows
        )}
      </div>
      {menu && (
        <ContextMenuSurface
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          className="menu-surface--standard"
          dismissOnScroll
          ariaLabel={t('common.more')}
        >
          {menuItems.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              className={`menu-surface__item${entry.danger ? ' menu-surface__item--danger' : ''}`}
              onClick={() => {
                setMenu(null);
                entry.run();
              }}
            >
              {entry.label}
            </button>
          ))}
        </ContextMenuSurface>
      )}
    </div>
  );
}

/**
 * A material in the tree: a thumbnail or note glyph, the title, and a short
 * preview (a note's first lines, a file's kind). Expanded, it shows the full
 * preview and the material's relations.
 */
function MaterialCell({
  item,
  renaming,
  onRenamed,
  previewOpen,
  onTogglePreview,
  relations,
  relationPickerOpen,
  onRelationPickerOpenChange,
  onAddRelation,
  onRemoveRelation,
  onOpen,
}: {
  item: LibraryItem;
  renaming: boolean;
  onRenamed: (title: string | null) => void;
  previewOpen: boolean;
  onTogglePreview: () => void;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  relationPickerOpen: boolean;
  onRelationPickerOpenChange: (open: boolean) => void;
  onAddRelation: (target: RelationTarget) => void;
  onRemoveRelation: (target: RelationTarget) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const binary = item.kind === 'image' || item.kind === 'pdf';
  const thumbnail = useStoredLibraryItemVariant(item, 'thumbnail', binary);
  const display = useStoredLibraryItemVariant(item, 'display', item.kind === 'image' && previewOpen);
  const excerpt = useMemo(
    () => (item.kind === 'text' ? extractTextFromCommentBody(item.bodyJson).replace(/\s+/gu, ' ').trim() : ''),
    [item.bodyJson, item.kind],
  );
  const kindLabel = t(`memoMaterial.kind.${item.kind}`, { defaultValue: item.kind });
  const selectedRelations = useMemo(() => new Set(relations.map((relation) => `${relation.toKind}:${relation.toId}`)), [relations]);
  const showRelations = relationPickerOpen || (previewOpen && relations.length > 0);
  const toggleLabel = previewOpen ? t('materialFolders.menu.collapsePreview') : t('materialFolders.menu.expandPreview');

  return (
    <div className="material-tree__cell">
      <div className="material-tree__cell-head">
        <span className={`material-tree__thumb material-tree__thumb--${item.kind}`} aria-hidden>
          {binary && thumbnail.fileUrl ? <img src={thumbnail.fileUrl} alt="" /> : <FileText size={14} strokeWidth={1.5} />}
        </span>
        <span className="material-tree__cell-text">
          {renaming ? (
            <NameInput initial={item.title} onDone={onRenamed} />
          ) : (
            <span className="material-tree__title">
              {item.title || <span className="material-tree__untitled">{t('common.untitled')}</span>}
            </span>
          )}
          {item.kind === 'text' ? (
            !previewOpen && (
              <span className="material-tree__excerpt">{excerpt || t('memoMaterial.card.addSnippetBody')}</span>
            )
          ) : (
            <span className="material-tree__meta">{kindLabel}</span>
          )}
        </span>
        <button
          type="button"
          className={`material-tree__preview-toggle${previewOpen ? ' material-tree__preview-toggle--open' : ''}`}
          aria-expanded={previewOpen}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePreview();
          }}
        >
          <ChevronRight size={12} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      {previewOpen && (
        <div className="material-tree__cell-extra" onClick={(event) => event.stopPropagation()}>
          {item.kind === 'text' && (
            <NoteExcerpt bodyJson={item.bodyJson} emptyLabel={t('memoMaterial.card.addSnippetBody')} clamp={false} onOpen={onOpen} />
          )}
          {item.kind === 'image' && display.fileUrl && (
            <button type="button" className="material-tree__image" title={t('memoMaterial.card.fullscreenImage')} onClick={onOpen}>
              <img src={display.fileUrl} alt="" />
            </button>
          )}
          {item.kind === 'pdf' && thumbnail.fileUrl && (
            <button type="button" className="material-tree__image" title={t('memoMaterial.preview.open')} onClick={onOpen}>
              <img src={thumbnail.fileUrl} alt="" />
            </button>
          )}
        </div>
      )}
      {showRelations && (
        <div className="material-tree__cell-extra" onClick={(event) => event.stopPropagation()}>
          <EntityRelationPicker
            selected={selectedRelations}
            onAdd={onAddRelation}
            onRemove={onRemoveRelation}
            open={relationPickerOpen}
            onOpenChange={onRelationPickerOpenChange}
          />
        </div>
      )}
    </div>
  );
}

function MoreButton({ label, onOpen }: { label: string; onOpen: (event: MouseEvent) => void }) {
  return (
    <button
      type="button"
      className="material-tree__more"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event);
      }}
    >
      <MoreHorizontal size={13} strokeWidth={1.6} />
    </button>
  );
}

function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const [composing, setComposing] = useState(false);
  // Enter commits and unmounts the input; the blur that follows must not commit again.
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="material-tree__rename"
      autoFocus
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (composing) return;
        if (event.key === 'Enter') finish(value);
        if (event.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}
