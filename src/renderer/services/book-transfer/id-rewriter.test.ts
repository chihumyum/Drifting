import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { plotGridCellId, plotGridDocumentId } from '../../sqlite-repo/plot-grid-repo';
import { createBookIdRewriter, rewriteAuthoredTables, rewriteYjsState } from './id-rewriter';

const PROJECT = '01a19c00-0000-7000-8000-000000000001';
const NODE = '01a19c00-0000-7000-8000-000000000002';
const ELEMENT = '01a19c00-0000-7000-8000-000000000003';
const BLOCK = '01a19c00-0000-7000-8000-0000000000b1';
const UNRELATED = '01a19c00-0000-7000-8000-0000000000ff';

function sequentialIds() {
  let next = 0;
  return () => `01a19c00-0000-7000-9000-${String(++next).padStart(12, '0')}`;
}

describe('book id rewriter', () => {
  const tables = [
    { table: 'project', rows: [{ id: PROJECT, name: 'Book' }] },
    { table: 'book_node', rows: [{ id: NODE, project_id: PROJECT }] },
    { table: 'element', rows: [{ id: ELEMENT, project_id: PROJECT }, { id: 'short-1', project_id: PROJECT }, { id: 'legacy-row', project_id: PROJECT }] },
    { table: 'plot_grid_document', rows: [{ id: plotGridDocumentId(NODE), node_id: NODE }] },
    { table: 'plot_grid_row', rows: [{ id: 'row-a', document_id: plotGridDocumentId(NODE) }] },
    { table: 'plot_grid_column', rows: [{ id: 'column-b', document_id: plotGridDocumentId(NODE) }] },
    {
      table: 'plot_grid_cell',
      rows: [{
        id: plotGridCellId(plotGridDocumentId(NODE), 'row-a', 'column-b'),
        document_id: plotGridDocumentId(NODE),
        row_id: 'row-a',
        column_id: 'column-b',
      }],
    },
  ];

  it('gives every row id a fresh one and rewrites every value that names it', () => {
    const rewriter = createBookIdRewriter(tables, sequentialIds());
    const project = rewriter.string(PROJECT);
    const node = rewriter.string(NODE);
    const element = rewriter.string(ELEMENT);
    expect(new Set([project, node, element, rewriter.string('short-1'), rewriter.string('row-a')]).size).toBe(5);
    expect(project).not.toBe(PROJECT);

    // Foreign keys, document ids, order scopes and JSON columns.
    expect(rewriter.string(`node-content:${NODE}`)).toBe(`node-content:${node}`);
    expect(rewriter.string(JSON.stringify([PROJECT, null]))).toBe(JSON.stringify([project, null]));
    expect(rewriter.string(JSON.stringify(['element', ELEMENT, 'facts']))).toBe(JSON.stringify(['element', element, 'facts']));
    expect(rewriter.string(`{"targetId":"${ELEMENT}","blockId":"${BLOCK}"}`)).toBe(`{"targetId":"${element}","blockId":"${BLOCK}"}`);
    // Shorter ids are rewritten where a value is exactly that id; longer ones wherever they appear.
    expect(rewriter.string('short-1')).not.toBe('short-1');
    expect(rewriter.string('see short-1 here')).toBe('see short-1 here');
    expect(rewriter.string('{"from":"legacy-row"}')).toBe(`{"from":"${rewriter.string('legacy-row')}"}`);

    // What is not one of the book's identities stays: block ids, other uuids, content hashes.
    expect(rewriter.string(BLOCK)).toBe(BLOCK);
    expect(rewriter.string(UNRELATED)).toBe(UNRELATED);
    const hash = `sha256:${'a'.repeat(64)}`;
    expect(rewriter.string(hash)).toBe(hash);

    expect(rewriter.value({ [ELEMENT]: [NODE, 3, null, true, new Uint8Array([1])] })).toEqual({
      [element]: [node, 3, null, true, new Uint8Array([1])],
    });
  });

  it('derives Plot Grid document and cell ids from their rewritten parts', () => {
    const rewriter = createBookIdRewriter(tables, sequentialIds());
    const documentId = plotGridDocumentId(rewriter.string(NODE));
    const cellId = plotGridCellId(documentId, rewriter.string('row-a'), rewriter.string('column-b'));
    expect(rewriter.string(plotGridDocumentId(NODE))).toBe(documentId);
    expect(rewriter.string(tables[6]!.rows[0]!.id)).toBe(cellId);

    const [cell] = rewriteAuthoredTables(tables, rewriter).find((entry) => entry.table === 'plot_grid_cell')!.rows;
    expect(cell).toEqual({
      id: cellId,
      document_id: documentId,
      row_id: rewriter.string('row-a'),
      column_id: rewriter.string('column-b'),
    });
    expect(rewriter.ids.size).toBe(9);
  });

  it('rewrites prose attributes, marks and embeds without touching text or block ids', () => {
    const rewriter = createBookIdRewriter(tables, sequentialIds());
    const source = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('id', BLOCK);
    paragraph.setAttribute('linkedNode', NODE);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    source.getXmlFragment('default').insert(0, [paragraph]);
    text.insert(0, 'Elizabeth ');
    text.insert(10, 'Bennet', { entityLink: { targetKind: 'element', targetId: ELEMENT } });
    text.insertEmbed(16, { mention: ELEMENT });
    text.insert(17, ` mentions ${ELEMENT} in plain text`);

    const rewritten = new Y.Doc();
    Y.applyUpdate(rewritten, rewriteYjsState(Y.encodeStateAsUpdate(source), rewriter));
    const copy = rewritten.getXmlFragment('default').get(0) as Y.XmlElement;
    expect(copy.getAttribute('id')).toBe(BLOCK);
    expect(copy.getAttribute('linkedNode')).toBe(rewriter.string(NODE));
    expect((copy.get(0) as Y.XmlText).toDelta()).toEqual([
      { insert: 'Elizabeth ' },
      { insert: 'Bennet', attributes: { entityLink: { targetKind: 'element', targetId: rewriter.string(ELEMENT) } } },
      { insert: { mention: rewriter.string(ELEMENT) } },
      { insert: ` mentions ${ELEMENT} in plain text` },
    ]);
    expect(yDocToProsemirrorJSON(rewritten, 'default')).toBeTruthy();
  });
});
