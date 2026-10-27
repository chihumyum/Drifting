import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, File, FileText, Folder, FolderOpen, FolderPlus, Image as ImageIcon, MoreHorizontal } from 'lucide-react';

import type { LibraryItem } from '../../domain/library-item';
import {
  buildMaterialFolderChildren,
  effectiveMaterialFolderId,
  materialFolderPath,
  ROOT_FOLDER_KEY,
  type MaterialFolder,
} from '../../domain/material-folder';
import { useDataStore } from '../../store/data-store';
import { requestConfirmation } from '../../store/confirmation-store';
import { useSidebarPanelState } from '../../hooks/useSidebarPanelState';
import { useMaterialFolder } from '../../usecase/useMaterialFolder';
import { ContextMenuSurface } from '../../components/ui/ContextMenuSurface';
import { EmptyState } from '../../components/ui/EmptyState';

const MATERIAL_DRAG = 'application/x-drifting-material';
const FOLDER_DRAG = 'application/x-drifting-material-folder';

type MenuTarget =
  | { kind: 'root' }
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
  onDeleteItem: (item: LibraryItem) => void;
  /** Opens the folder picker for these materials. */
  onMoveItems: (libraryItemIds: string[], currentFolderId: string | null) => void;
  /** Bumped by the panel toolbar: create a folder in the current one and name it. */
  newFolderRequest?: number;
}

function compareItems(a: LibraryItem, b: LibraryItem): number {
  if (!a.title !== !b.title) return a.title ? -1 : 1;
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);
}

function KindIcon({ item }: { item: LibraryItem }) {
  if (item.kind === 'text') return <FileText size={13} strokeWidth={1.6} aria-hidden />;
  if (item.kind === 'image') return <ImageIcon size={13} strokeWidth={1.6} aria-hidden />;
  return <File size={13} strokeWidth={1.6} aria-hidden />;
}

/**
 * The material panel's folder view. Desktop shows a Finder-style tree:
 * disclosure triangles, drag a material or folder onto a folder (or the empty
 * area for the root), right-click to create, rename, move or delete, and
 * ⌘-click to select several materials. Mobile shows one folder at a time
 * under a breadcrumb.
 */
export function MaterialFolderTree(props: MaterialFolderTreeProps) {
  const { t } = useTranslation();
  const { projectId, items, narrowed, presentation, currentFolderId, onCurrentFolderChange } = props;
  const folders = useDataStore((state) => state.materialFolders);
  const folderUsecases = useMaterialFolder(projectId);
  const [expanded, setExpanded] = useSidebarPanelState<string[]>('expandedFolders', []);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

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

  const newFolder = async (parentFolderId: string | null) => {
    const folder = await folderUsecases.createFolder({ name: t('materialFolders.untitled'), parentFolderId });
    if (parentFolderId) setFolderExpanded(parentFolderId, true);
    setRenamingId(folder.id);
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
  const deleteFolder = async (folder: MaterialFolder) => {
    const confirmed = await requestConfirmation(t('materialFolders.deleteConfirm', { name: folder.name }));
    if (!confirmed) return;
    await folderUsecases.deleteFolder(folder.id);
    if (currentFolderId === folder.id) onCurrentFolderChange(folder.parentFolderId);
  };

  const dragIds = (item: LibraryItem) => (selected.includes(item.id) ? selected : [item.id]);
  const acceptsDrop = (event: DragEvent) =>
    event.dataTransfer.types.includes(MATERIAL_DRAG) || event.dataTransfer.types.includes(FOLDER_DRAG);
  const dropInto = (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropKey(null);
    const materialIds = event.dataTransfer.getData(MATERIAL_DRAG);
    const folderId_ = event.dataTransfer.getData(FOLDER_DRAG);
    if (materialIds) void folderUsecases.moveMaterialsToFolder(materialIds.split(','), folderId);
    else if (folderId_) void folderUsecases.moveFolder(folderId_, folderId);
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

  const openMenu = (event: MouseEvent, target: MenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  };

  const folderRow = (folder: MaterialFolder, depth: number, onActivate: () => void, open: boolean, showDisclosure: boolean) => (
    <div
      key={`folder:${folder.id}`}
      role="treeitem"
      aria-expanded={showDisclosure ? open : undefined}
      tabIndex={0}
      className={`material-tree__row material-tree__row--folder${dropKey === folder.id ? ' material-tree__row--drop' : ''}${currentFolderId === folder.id && presentation === 'desktop' ? ' material-tree__row--current' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      draggable={presentation === 'desktop' && renamingId !== folder.id}
      onDragStart={(event) => {
        event.dataTransfer.setData(FOLDER_DRAG, folder.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      {...dropZone(folder.id, folder.id)}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => openMenu(event, { kind: 'folder', folder })}
    >
      {showDisclosure ? (
        <ChevronRight
          size={11}
          strokeWidth={1.8}
          className={`material-tree__chevron${open ? ' material-tree__chevron--open' : ''}`}
          aria-hidden
        />
      ) : (
        <span className="material-tree__chevron-space" aria-hidden />
      )}
      {open && showDisclosure ? <FolderOpen size={13} strokeWidth={1.6} aria-hidden /> : <Folder size={13} strokeWidth={1.6} aria-hidden />}
      {renamingId === folder.id ? (
        <FolderNameInput
          initial={folder.name}
          onDone={(name) => {
            setRenamingId(null);
            if (name !== null) void folderUsecases.renameFolder(folder.id, name);
          }}
        />
      ) : (
        <span className="material-tree__name">{folder.name}</span>
      )}
      <span className="material-tree__count">{totals.get(folder.id) ?? 0}</span>
      {presentation === 'mobile' && (
        <MoreButton label={t('common.more')} onOpen={(event) => openMenu(event, { kind: 'folder', folder })} />
      )}
    </div>
  );

  const itemRow = (item: LibraryItem, depth: number) => {
    const active = item.id === props.activeLibraryItemId;
    const isSelected = selected.includes(item.id);
    return (
      <div
        key={`item:${item.id}`}
        role="treeitem"
        aria-selected={isSelected || active}
        tabIndex={0}
        className={`material-tree__row material-tree__row--item${active ? ' material-tree__row--active' : ''}${isSelected ? ' material-tree__row--selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={presentation === 'desktop'}
        onDragStart={(event) => {
          event.dataTransfer.setData(MATERIAL_DRAG, dragIds(item).join(','));
          event.dataTransfer.effectAllowed = 'move';
        }}
        onClick={(event) => {
          if (presentation === 'desktop' && (event.metaKey || event.ctrlKey)) {
            setSelected(isSelected ? selected.filter((id) => id !== item.id) : [...selected, item.id]);
            return;
          }
          setSelected([]);
          props.onOpenItem(item);
        }}
        onDoubleClick={() => props.onPinItem?.(item)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== 'Enter') return;
          props.onOpenItem(item);
        }}
        onContextMenu={(event) => openMenu(event, { kind: 'item', item })}
      >
        <span className="material-tree__chevron-space" aria-hidden />
        <KindIcon item={item} />
        <span className="material-tree__name">{item.title || t('common.untitled')}</span>
        <span className="material-tree__kind">{t(`memoMaterial.kind.${item.kind}`, { defaultValue: item.kind })}</span>
        {presentation === 'mobile' && (
          <MoreButton label={t('common.more')} onOpen={(event) => openMenu(event, { kind: 'item', item })} />
        )}
      </div>
    );
  };

  const visibleFolders = (key: string) =>
    (children.get(key) ?? []).filter((folder) => !narrowed || (totals.get(folder.id) ?? 0) > 0);

  const desktopRows = (key: string, depth: number): ReactNode[] => [
    ...visibleFolders(key).flatMap((folder) => {
      const open = isExpanded(folder.id);
      const row = folderRow(
        folder,
        depth,
        () => {
          onCurrentFolderChange(folder.id);
          setFolderExpanded(folder.id, !open);
        },
        open,
        true,
      );
      return open ? [row, ...desktopRows(folder.id, depth + 1)] : [row];
    }),
    ...(itemsByFolder.get(key) ?? []).map((item) => itemRow(item, depth)),
  ];

  const mobileKey = currentFolderId !== null && folders.some((folder) => folder.id === currentFolderId) ? currentFolderId : ROOT_FOLDER_KEY;
  const breadcrumb = materialFolderPath(folders, mobileKey === ROOT_FOLDER_KEY ? null : mobileKey);
  const rows =
    presentation === 'desktop'
      ? desktopRows(ROOT_FOLDER_KEY, 0)
      : [
          ...visibleFolders(mobileKey).map((folder) =>
            folderRow(folder, 0, () => onCurrentFolderChange(folder.id), false, false),
          ),
          ...(itemsByFolder.get(mobileKey) ?? []).map((item) => itemRow(item, 0)),
        ];

  const menuTarget = menu?.target;
  const menuItems: Array<{ label: string; danger?: boolean; run: () => void }> = !menuTarget
    ? []
    : menuTarget.kind === 'root'
      ? [{ label: t('materialFolders.menu.newFolder'), run: () => void newFolder(null) }]
      : menuTarget.kind === 'folder'
        ? [
            { label: t('materialFolders.menu.newSubfolder'), run: () => void newFolder(menuTarget.folder.id) },
            { label: t('materialFolders.menu.rename'), run: () => setRenamingId(menuTarget.folder.id) },
            { label: t('materialFolders.menu.delete'), danger: true, run: () => void deleteFolder(menuTarget.folder) },
          ]
        : [
            { label: t('materialFolders.menu.open'), run: () => props.onOpenItem(menuTarget.item) },
            {
              label:
                selected.length > 1 && selected.includes(menuTarget.item.id)
                  ? t('materialFolders.menu.moveSelected', { count: selected.length })
                  : t('materialFolders.menu.move'),
              run: () =>
                props.onMoveItems(
                  selected.includes(menuTarget.item.id) ? selected : [menuTarget.item.id],
                  menuTarget.item.folderId,
                ),
            },
            ...(menuTarget.item.kind === 'text'
              ? []
              : [{ label: t('memoMaterial.menu.openInSystem'), run: () => props.onOpenInSystem(menuTarget.item) }]),
            { label: t('memoMaterial.menu.deleteMaterial'), danger: true, run: () => props.onDeleteItem(menuTarget.item) },
          ];

  return (
    <div className="material-tree">
      {presentation === 'mobile' && (
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
        className={`material-tree__rows${dropKey === ROOT_FOLDER_KEY ? ' material-tree__rows--drop' : ''}`}
        {...dropZone(ROOT_FOLDER_KEY, null)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          setSelected([]);
          onCurrentFolderChange(null);
        }}
        onContextMenu={(event) => openMenu(event, { kind: 'root' })}
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

function FolderNameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
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
