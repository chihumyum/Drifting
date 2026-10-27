// Material folder (素材文件夹) — a user-defined nested folder in the material
// panel. A folder is a row with a `parentFolderId` link (null = root);
// membership lives on library_item.folder_id. Tree derivation lives here;
// persistence in sqlite-repo/material-folder-repo + the synced
// `material_folder` table; mutations (create / rename / move /
// delete-with-reparent) in usecase/useMaterialFolder.

export interface MaterialFolder {
  id: string;
  projectId: string;
  name: string;
  /** null = root-level folder. Moves never make a folder its own ancestor. */
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ROOT_FOLDER_KEY = ' root';

/** Siblings sort by name, as in Finder, with a stable id tiebreak. */
export function compareMaterialFolders(a: MaterialFolder, b: MaterialFolder): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The parent each folder is shown under. Concurrent moves on two devices can
 * leave a parent link pointing at a deleted folder or close a loop; a missing
 * parent shows the folder at the root, and a loop is broken at its member
 * with the smallest id, so every device draws the same tree and nothing
 * becomes unreachable.
 */
export function effectiveParentFolderIds(folders: readonly MaterialFolder[]): Map<string, string | null> {
  const ids = new Set(folders.map((folder) => folder.id));
  const parents = new Map<string, string | null>(
    folders.map((folder) => [
      folder.id,
      folder.parentFolderId !== null && ids.has(folder.parentFolderId) ? folder.parentFolderId : null,
    ]),
  );
  const state = new Map<string, 'visiting' | 'done'>();
  for (const folder of folders) {
    const path: string[] = [];
    let current: string | null = folder.id;
    while (current !== null && !state.has(current)) {
      state.set(current, 'visiting');
      path.push(current);
      current = parents.get(current) ?? null;
    }
    if (current !== null && state.get(current) === 'visiting') {
      const loop = path.slice(path.indexOf(current));
      parents.set([...loop].sort()[0]!, null);
    }
    for (const id of path) state.set(id, 'done');
  }
  return parents;
}

/** children[parentId ?? ROOT_FOLDER_KEY] = direct child folders, sorted. */
export function buildMaterialFolderChildren(folders: readonly MaterialFolder[]): Map<string, MaterialFolder[]> {
  const parents = effectiveParentFolderIds(folders);
  const byParent = new Map<string, MaterialFolder[]>();
  for (const folder of folders) {
    const key = parents.get(folder.id) ?? ROOT_FOLDER_KEY;
    const list = byParent.get(key);
    if (list) list.push(folder);
    else byParent.set(key, [folder]);
  }
  for (const list of byParent.values()) list.sort(compareMaterialFolders);
  return byParent;
}

/** True when `candidateId` is `ancestorId` or anywhere below it. */
export function isDescendantFolder(
  folders: readonly MaterialFolder[],
  candidateId: string,
  ancestorId: string,
): boolean {
  if (candidateId === ancestorId) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  let current = byId.get(candidateId)?.parentFolderId ?? null;
  while (current !== null) {
    if (current === ancestorId) return true;
    if (seen.has(current)) break;
    seen.add(current);
    current = byId.get(current)?.parentFolderId ?? null;
  }
  return false;
}

/** Folder names from the root down to `folderId`; empty for the root or a missing folder. */
export function materialFolderPath(folders: readonly MaterialFolder[], folderId: string | null): MaterialFolder[] {
  if (folderId === null) return [];
  const parents = effectiveParentFolderIds(folders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: MaterialFolder[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !seen.has(current)) {
    const folder = byId.get(current);
    if (!folder) break;
    seen.add(current);
    path.unshift(folder);
    current = parents.get(current) ?? null;
  }
  return path;
}

/** Every folder in tree order (depth first, siblings by name), with its depth. */
export function flattenMaterialFolders(
  folders: readonly MaterialFolder[],
): Array<{ folder: MaterialFolder; depth: number }> {
  const children = buildMaterialFolderChildren(folders);
  const rows: Array<{ folder: MaterialFolder; depth: number }> = [];
  const visit = (key: string, depth: number) => {
    for (const folder of children.get(key) ?? []) {
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(ROOT_FOLDER_KEY, 0);
  return rows;
}

/** The folder a material is shown in: its own, or the root when that folder is gone. */
export function effectiveMaterialFolderId(
  folderIds: ReadonlySet<string>,
  folderId: string | null,
): string | null {
  return folderId !== null && folderIds.has(folderId) ? folderId : null;
}
