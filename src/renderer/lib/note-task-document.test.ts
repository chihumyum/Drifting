import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { yLinkedTaskIds, yRemoveLinkedTaskItems, ySetTaskLinks } from './note-task-document';

function taskItem(id: string, todoId: string | null, text: string, nested?: Y.XmlElement): Y.XmlElement {
  const item = new Y.XmlElement('taskItem');
  item.setAttribute('id', id);
  if (todoId !== null) item.setAttribute('todoId', todoId);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  item.insert(0, nested ? [paragraph, nested] : [paragraph]);
  return item;
}

function checklist(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const nested = new Y.XmlElement('taskList');
  nested.insert(0, [taskItem('c', 'todo-c', '核对年份')]);
  const list = new Y.XmlElement('taskList');
  list.insert(0, [taskItem('a', 'todo-a', '找潮汐表', nested), taskItem('plain', '', '散记')]);
  const lone = new Y.XmlElement('taskList');
  lone.insert(0, [taskItem('b', 'todo-b', '查年代')]);
  fragment.insert(0, [list, lone]);
  return { doc, fragment };
}

describe('note task lines', () => {
  it('removes linked items and drops lists left empty', () => {
    const { doc, fragment } = checklist();
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

  it('moves a removed line\'s sub-tasks up into its place', () => {
    const { doc, fragment } = checklist();
    expect(yRemoveLinkedTaskItems(fragment, new Set(['todo-a']))).toBe(1);
    const list = fragment.get(0) as Y.XmlElement;
    expect(list.toArray().map((item) => (item as Y.XmlElement).getAttribute('id'))).toEqual(['c', 'plain']);
    expect((list.get(0) as Y.XmlElement).getAttribute('todoId')).toBe('todo-c');
    expect(fragment.toString()).not.toContain('找潮汐表');
    doc.destroy();
  });

  it('reads the links, nested ones included, and skips plain checkboxes', () => {
    const { doc, fragment } = checklist();
    expect([...yLinkedTaskIds(fragment)].sort()).toEqual(['todo-a', 'todo-b', 'todo-c']);
    doc.destroy();
  });

  it('relinks lines by block id, clearing a link to leave the line for projection', () => {
    const { doc, fragment } = checklist();
    const links = new Map<string, string | null>([
      ['a', 'todo-new'],
      ['c', null],
      ['gone', 'todo-x'],
    ]);
    expect(ySetTaskLinks(fragment, links)).toBe(2);
    expect([...yLinkedTaskIds(fragment)].sort()).toEqual(['todo-b', 'todo-new']);
    // Already in place: nothing to write.
    expect(ySetTaskLinks(fragment, links)).toBe(0);
    doc.destroy();
  });
});
