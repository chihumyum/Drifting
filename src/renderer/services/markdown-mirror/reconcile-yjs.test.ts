import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  planWorkspaceProseFileBlocks,
  renderWorkspaceProseFile,
} from '../../lib/agent/runtime/workspace-prose-file';
import {
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
  type YjsProseBlock,
} from '../../lib/agent/runtime/yjs-prose-command';
import { diffText, reconcileProseBlocks } from './reconcile-yjs';

const paragraph = (id: string, text: string, marks?: Record<string, unknown>): YjsProseBlock => ({
  id,
  type: 'paragraph',
  content: [{ kind: 'text', text, ...(marks ? { marks: marks as never } : {}) }],
});

function docWith(blocks: YjsProseBlock[]): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  replaceYjsProseBlocks(doc, blocks);
  return doc;
}

function clone(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function textOf(doc: Y.Doc): string[] {
  return snapshotYjsProseBlocks(doc).map((block) =>
    (block.content ?? []).map((node) => (node.kind === 'text' ? node.text : '\n')).join(''),
  );
}

/** Edits a fork of `base` so its prose reads `content`, returning the update. */
async function fileEdit(base: Y.Doc, content: string): Promise<{ update: Uint8Array; touched: string[] }> {
  const fork = clone(base);
  const updates: Uint8Array[] = [];
  fork.on('update', (update: Uint8Array) => updates.push(update));
  const desired = await planWorkspaceProseFileBlocks({
    blocks: snapshotYjsProseBlocks(fork),
    content,
    idempotencyKey: 'test',
    matchRendered: true,
  });
  let touched: string[] = [];
  fork.transact(() => {
    touched = reconcileProseBlocks(fork.getXmlFragment('default'), desired);
  });
  fork.destroy();
  return { update: Y.mergeUpdates(updates), touched };
}

function insertText(doc: Y.Doc, blockIndex: number, at: number, text: string) {
  const element = doc.getXmlFragment('default').get(blockIndex) as Y.XmlElement;
  (element.get(0) as Y.XmlText).insert(at, text);
}

describe('merging a Markdown file edit as a concurrent peer', () => {
  it('keeps both sides of edits to the same paragraph in place', async () => {
    const base = docWith([paragraph('p1', '林岚推开门。雨很大。'), paragraph('p2', '屋里很暗。')]);
    const current = clone(base);
    // Drifting typed while the file was being edited elsewhere.
    insertText(current, 0, 2, '缓缓');

    const { update, touched } = await fileEdit(base, '林岚推开门。雨下得很大。\n\n屋里很暗。');
    expect(touched).toEqual(['p1']);
    Y.applyUpdate(current, update);

    expect(textOf(current)).toEqual(['林岚缓缓推开门。雨下得很大。', '屋里很暗。']);
    expect(snapshotYjsProseBlocks(current).map((block) => block.id)).toEqual(['p1', 'p2']);
  });

  it('interleaves rather than drops two edits at one spot', async () => {
    const base = docWith([paragraph('p1', '他笑了。')]);
    const current = clone(base);
    insertText(current, 0, 1, '苦');
    const { update } = await fileEdit(base, '他哭了。');
    Y.applyUpdate(current, update);
    const [text] = textOf(current);
    expect(['他苦哭了。', '他哭苦了。']).toContain(text);
  });

  it('adds and removes paragraphs without renaming the others', async () => {
    const base = docWith([
      paragraph('p1', '第一段。'),
      paragraph('p2', '第二段。'),
      { id: 'h1', type: 'heading', attrs: { level: 1 }, content: [{ kind: 'text', text: '第一场' }] },
    ]);
    const { update } = await fileEdit(base, '第一段。\n\n新插入的一段。\n\n## 第一场');
    const current = clone(base);
    Y.applyUpdate(current, update);
    const blocks = snapshotYjsProseBlocks(current);
    expect(blocks.map((block) => block.id).filter((id) => id === 'p1' || id === 'h1')).toEqual(['p1', 'h1']);
    expect(blocks.some((block) => block.id === 'p2')).toBe(false);
    expect(textOf(current)).toEqual(['第一段。', '新插入的一段。', '第一场']);
    expect(blocks.find((block) => block.id === 'h1')!.attrs).toEqual({ level: 2 });
  });

  it('applies formatting from the file and never touches entity links', async () => {
    const link = { entityLink: { targetKind: 'element', targetId: 'e1', targetBlockId: null } };
    const base = docWith([
      {
        id: 'p1',
        type: 'paragraph',
        content: [
          { kind: 'text', text: '林岚', marks: link as never },
          { kind: 'text', text: '推开门。' },
        ],
      },
    ]);
    expect(renderWorkspaceProseFile(snapshotYjsProseBlocks(base))).toBe('林岚推开门。');
    const { update } = await fileEdit(base, '林岚轻轻**推开**门。');
    const current = clone(base);
    Y.applyUpdate(current, update);
    const content = snapshotYjsProseBlocks(current)[0]!.content!;
    expect(content).toEqual([
      { kind: 'text', text: '林岚', marks: link },
      { kind: 'text', text: '轻轻' },
      { kind: 'text', text: '推开', marks: { bold: {} } },
      { kind: 'text', text: '门。' },
    ]);
  });

  it('rebuilds only the inline content when a line break appears', async () => {
    const base = docWith([paragraph('p1', '第一行第二行')]);
    const { update } = await fileEdit(base, '第一行<br>第二行');
    const current = clone(base);
    Y.applyUpdate(current, update);
    const block = snapshotYjsProseBlocks(current)[0]!;
    expect(block.id).toBe('p1');
    expect(block.content).toEqual([
      { kind: 'text', text: '第一行' },
      { kind: 'element', type: 'hardBreak' },
      { kind: 'text', text: '第二行' },
    ]);
  });

  it('changes nothing when the file still says what the base says', async () => {
    const base = docWith([paragraph('p1', '一字未改。')]);
    const { update, touched } = await fileEdit(base, renderWorkspaceProseFile(snapshotYjsProseBlocks(base)));
    expect(touched).toEqual([]);
    const current = clone(base);
    const before = Y.encodeStateVector(current);
    Y.applyUpdate(current, update);
    expect(Y.encodeStateVector(current)).toEqual(before);
  });
});

describe('a file edit inside an entity link', () => {
  const annati = { entityLink: { targetKind: 'element', targetId: 'annati', targetBlockId: null } };
  const mitch = { entityLink: { targetKind: 'element', targetId: 'mitch', targetBlockId: null } };

  /** A paragraph whose runs share one Y.XmlText, so the file edit is merged character by character. */
  function oneTextChild(runs: Array<[string, Record<string, unknown>?]>): Y.Doc {
    const doc = docWith([paragraph('p1', '…')]);
    const element = doc.getXmlFragment('default').get(0) as Y.XmlElement;
    element.delete(0, element.length);
    const text = new Y.XmlText();
    element.insert(0, [text]);
    let offset = 0;
    for (const [insert, attributes] of runs) {
      text.insert(offset, insert, attributes ?? {});
      offset += insert.length;
    }
    return doc;
  }

  async function merged(base: Y.Doc, content: string) {
    const { update } = await fileEdit(base, content);
    const current = clone(base);
    Y.applyUpdate(current, update);
    return snapshotYjsProseBlocks(current)[0]!.content!;
  }

  it('keeps a name respelled character by character in its link', async () => {
    const base = oneTextChild([['安娜蒂', annati], ['对米契说。']]);
    expect(await merged(base, '安纳蒂对米契说。')).toEqual([
      { kind: 'text', text: '安纳蒂', marks: annati },
      { kind: 'text', text: '对米契说。' },
    ]);
  });

  it('keeps a name respelled in a rebuilt paragraph in its link', async () => {
    const base = docWith([
      {
        id: 'p1',
        type: 'paragraph',
        content: [
          { kind: 'text', text: '安娜蒂', marks: annati as never },
          { kind: 'text', text: '对' },
          { kind: 'text', text: '米契', marks: mitch as never },
          { kind: 'text', text: '说。' },
        ],
      },
    ]);
    expect(await merged(base, '安纳蒂对米契说。')).toEqual([
      { kind: 'text', text: '安纳蒂', marks: annati },
      { kind: 'text', text: '对' },
      { kind: 'text', text: '米契', marks: mitch },
      { kind: 'text', text: '说。' },
    ]);
  });

  it('does not join two links when the text between them changes', async () => {
    const base = oneTextChild([['米契', mitch], ['，'], ['米契', mitch]]);
    expect(await merged(base, '米契。米契')).toEqual([
      { kind: 'text', text: '米契', marks: mitch },
      { kind: 'text', text: '。' },
      { kind: 'text', text: '米契', marks: mitch },
    ]);
  });
});

describe('character diff', () => {
  it('never splits a surrogate pair', () => {
    const edits = diffText('雨😀夜', '雨😃夜');
    expect(edits).toEqual([
      { kind: 'equal', text: '雨' },
      { kind: 'delete', text: '😀' },
      { kind: 'insert', text: '😃' },
      { kind: 'equal', text: '夜' },
    ]);
  });

  it('falls back to one replacement for a huge rewritten paragraph', () => {
    const before = 'a'.repeat(1500);
    const after = 'b'.repeat(1500);
    expect(diffText(before, after)).toEqual([
      { kind: 'delete', text: before },
      { kind: 'insert', text: after },
    ]);
  });
});
