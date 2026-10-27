import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  buildMaterialFolderChildren,
  effectiveParentFolderIds,
  flattenMaterialFolders,
  isDescendantFolder,
  materialFolderPath,
  ROOT_FOLDER_KEY,
  type MaterialFolder,
} from './material-folder';
import { yRemoveLinkedTaskItems } from '../lib/note-task-document';

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

describe('removing a note task line', () => {
  function taskItem(todoId: string | null, text: string, nested?: Y.XmlElement): Y.XmlElement {
    const item = new Y.XmlElement('taskItem');
    if (todoId !== null) item.setAttribute('todoId', todoId);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    item.insert(0, nested ? [paragraph, nested] : [paragraph]);
    return item;
  }

  it('removes linked items with their sub-tasks and drops lists left empty', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const nested = new Y.XmlElement('taskList');
    nested.insert(0, [taskItem('todo-c', '核对年份')]);
    const list = new Y.XmlElement('taskList');
    list.insert(0, [taskItem('todo-a', '找潮汐表', nested), taskItem(null, '散记')]);
    const lone = new Y.XmlElement('taskList');
    lone.insert(0, [taskItem('todo-b', '查年代')]);
    fragment.insert(0, [list, lone]);

    expect(yRemoveLinkedTaskItems(fragment, new Set(['todo-c', 'todo-b']))).toBe(2);
    expect(fragment.toString()).not.toContain('核对年份');
    expect(fragment.toString()).not.toContain('查年代');
    // The emptied nested list and the emptied top-level list are gone.
    expect(fragment.length).toBe(1);
    expect(fragment.toString()).toContain('找潮汐表');
    expect((fragment.get(0) as Y.XmlElement).toString()).not.toMatch(/<taskList><\/taskList>/);

    expect(yRemoveLinkedTaskItems(fragment, new Set(['missing']))).toBe(0);
    doc.destroy();
  });
});
