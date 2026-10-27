import { describe, expect, it } from 'vitest';

import {
  buildMaterialFolderChildren,
  effectiveParentFolderIds,
  flattenMaterialFolders,
  isDescendantFolder,
  materialFolderPath,
  ROOT_FOLDER_KEY,
  type MaterialFolder,
} from './material-folder';

function folder(id: string, name: string, parentFolderId: string | null = null): MaterialFolder {
  return { id, projectId: 'p', name, parentFolderId, createdAt: '', updatedAt: '' };
}

describe('material folders', () => {
  const tree = [
    folder('research', '调研'),
    folder('maps', '地图', 'research'),
    folder('photos', '照片', 'research'),
    folder('archive', 'Archive'),
    folder('item10', 'Item 10'),
    folder('item2', 'Item 2'),
  ];

  it('nests folders and sorts siblings by name, numbers naturally', () => {
    const children = buildMaterialFolderChildren(tree);
    expect(children.get(ROOT_FOLDER_KEY)?.map((entry) => entry.id)).toEqual(['archive', 'item2', 'item10', 'research']);
    expect(children.get('research')?.map((entry) => entry.id)).toEqual(['maps', 'photos']);
    expect(flattenMaterialFolders(tree).map(({ folder: entry, depth }) => `${depth}:${entry.id}`)).toEqual([
      '0:archive',
      '0:item2',
      '0:item10',
      '0:research',
      '1:maps',
      '1:photos',
    ]);
  });

  it('builds the path from the root and refuses moves into a subtree', () => {
    expect(materialFolderPath(tree, 'maps').map((entry) => entry.name)).toEqual(['调研', '地图']);
    expect(materialFolderPath(tree, null)).toEqual([]);
    expect(materialFolderPath(tree, 'gone')).toEqual([]);
    expect(isDescendantFolder(tree, 'maps', 'research')).toBe(true);
    expect(isDescendantFolder(tree, 'research', 'maps')).toBe(false);
    expect(isDescendantFolder(tree, 'research', 'research')).toBe(true);
  });

  it('shows folders behind a deleted parent or a loop at the root, the same on every device', () => {
    const broken = [
      folder('orphan', 'Orphan', 'deleted'),
      // Two devices moved a into b and b into a at the same time.
      folder('b', 'B', 'a'),
      folder('a', 'A', 'b'),
      folder('child', 'Child', 'b'),
    ];
    const parents = effectiveParentFolderIds(broken);
    expect(parents.get('orphan')).toBeNull();
    expect(parents.get('a')).toBeNull();
    expect(parents.get('b')).toBe('a');
    expect(parents.get('child')).toBe('b');
    expect(flattenMaterialFolders(broken).map(({ folder: entry }) => entry.id)).toEqual(['a', 'b', 'child', 'orphan']);
    expect(materialFolderPath(broken, 'child').map((entry) => entry.id)).toEqual(['a', 'b', 'child']);
  });
});
