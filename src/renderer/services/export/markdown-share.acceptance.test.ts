import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { installHeadlessDatabaseClient } from '../../lib/db';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { registerLiveYDoc } from '../../lib/yjs-doc-registry';
import { BookActTable, BookElementTable, BookNodeTable, ElementCategoryTable, NodeContentTable,
  ProjectTable, StorylineTable, yjsSnapshots, yjsUpdates } from '../../schema/drizzle';
import { readMarkdownShare } from './markdown-share.service';
import { markdownShareFilename, proseToShareMarkdown } from './markdown-share';

const PROJECT = 'synthetic-share-book';
const NOW = '2026-10-02T00:00:00.000Z';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const prose = (text: string) => JSON.stringify({ type: 'doc', content: [
  { type: 'paragraph', attrs: { id: 'synthetic-block' }, content: [{ type: 'text', text }] },
] });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-markdown-share-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  cleanups.push(installHeadlessDatabaseClient(db, 'synthetic-share.db'));
  await db.insert(ProjectTable).values({ id: PROJECT, name: '合成书稿', userId: 'synthetic', createdAt: NOW, updatedAt: NOW });
  const node = async (id: string, order: number, text: string, overrides: Partial<typeof BookNodeTable.$inferInsert> = {}) => {
    await db.insert(BookNodeTable).values({ id, projectId: PROJECT, title: `Chapter ${id}`, bookOrder: order,
      kind: 'chapter', summary: '', positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW, ...overrides });
    await db.insert(NodeContentTable).values({ nodeId: id, contentJson: prose(text), plotGridJson: '{"private":"PLAN"}', createdAt: NOW, updatedAt: NOW });
  };
  return { db, node, gateway };
}

describe('editor Markdown sharing acceptance', () => {
  it('reads all never-mounted chapters across Yjs batch boundaries in book order, excluding drift and trash', async () => {
    const { node, gateway } = await fixture();
    for (let index = 40; index >= 0; index--) await node(`c${index}`, index + .5, `Unique prose ${index}`, { summary: `Chapter overview ${index}` });
    await node('drift', 1, 'PRIVATE DRIFT', { kind: 'drift', bookOrder: null });
    await node('trash', 2, 'PRIVATE TRASH', { deletedAt: NOW });
    const before = gateway.database.prepare('SELECT total_changes() AS changes').get();
    const result = await readMarkdownShare({ projectId: PROJECT, title: 'stale', kind: 'book' });
    expect(result.documentCount).toBe(41);
    expect(result.filename).toBe('合成书稿.md');
    expect(result.markdown.match(/^## Chapter c\d+$/gm)).toEqual(Array.from({ length: 41 }, (_, index) => `## Chapter c${index}`));
    for (let index = 0; index <= 40; index++) expect(result.markdown).toContain(`## Chapter c${index}\n\n> Chapter overview ${index}\n\nUnique prose ${index}`);
    expect(result.markdown).not.toMatch(/PRIVATE|PLAN|drift|trash/);
    expect(gateway.database.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
  });

  it('places chapter summaries below titles in single and whole-book shares, escaping text and omitting blank summaries', async () => {
    const { node } = await fixture();
    await node('summary', 1, 'Chapter prose', { summary: '  合成 *概要* <tag>\r\n第二行 👋  ' });
    await node('blank', 2, 'Blank-summary prose', { summary: ' \r\n\t ' });
    await node('drift', 3, 'Drift prose', { kind: 'drift', bookOrder: null, summary: 'PRIVATE DRIFT SUMMARY' });
    const expectedSummary = '> 合成 \\*概要\\* \\<tag><br>第二行 👋';
    const read = (id: string) => readMarkdownShare({ projectId: PROJECT, title: '', kind: 'node', id });
    expect((await read('summary')).markdown).toBe(`# Chapter summary\n\n${expectedSummary}\n\nChapter prose\n`);
    expect((await read('blank')).markdown).toBe('# Chapter blank\n\nBlank-summary prose\n');
    expect((await read('drift')).markdown).toBe('# Chapter drift\n\nDrift prose\n');
    const book = await readMarkdownShare({ projectId: PROJECT, title: '', kind: 'book' });
    expect(book.markdown).toBe(`# 合成书稿\n\n## Chapter summary\n\n${expectedSummary}\n\nChapter prose\n\n## Chapter blank\n\nBlank-summary prose\n`);
  });

  it('uses live CRDT including empty prose, persisted snapshot plus update, and seed-only content', async () => {
    const { db, node } = await fixture();
    for (const id of ['live', 'empty', 'persisted', 'seed']) await node(id, 1, `STALE ${id}`);
    const seed = await createYjsProseSeedState(prose('Canonical'));
    const doc = new Y.Doc(); Y.applyUpdate(doc, seed); cleanups.push(() => doc.destroy());
    const updates: Uint8Array[] = [];
    doc.on('update', update => updates.push(update));
    const text = (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(text.length, ' persisted tail');
    for (const id of ['live', 'empty', 'persisted']) {
      await db.insert(yjsSnapshots).values({ docId: `node-content:${id}`, stateBlob: seed, updatedAt: NOW });
      await db.insert(yjsUpdates).values({ docId: `node-content:${id}`, updateBlob: updates[0], createdAt: NOW });
    }
    text.insert(text.length, ' UNSAVED live tail');
    cleanups.push(registerLiveYDoc('node-content:live', doc));
    const empty = new Y.Doc(); cleanups.push(() => empty.destroy());
    cleanups.push(registerLiveYDoc('node-content:empty', empty));
    const read = (id: string) => readMarkdownShare({ projectId: PROJECT, title: '', kind: 'node', id });
    expect((await read('live')).markdown).toContain('Canonical persisted tail UNSAVED live tail');
    expect((await read('persisted')).markdown).toBe('# Chapter persisted\n\nCanonical persisted tail\n');
    expect((await read('empty')).markdown).toBe('# Chapter empty\n');
    expect((await read('seed')).markdown).toContain('STALE seed');
  });

  it('preserves act/chapter/scene/beat/note hierarchy and chapters preceding the first act', async () => {
    const { db, node } = await fixture();
    await node('preface', 1, 'Opening'); await node('inside', 3, 'Body');
    await db.insert(BookActTable).values({ id: 'act', projectId: PROJECT, name: 'Act One', startOrder: 2, createdAt: NOW, updatedAt: NOW });
    await db.update(NodeContentTable).set({ contentJson: JSON.stringify({ type: 'doc', content: [1, 2, 3].map(level => ({
      type: 'heading', attrs: { level, id: `h${level}` }, content: [{ type: 'text', text: `Outline ${level}` }],
    })) }) }).where(eq(NodeContentTable.nodeId, 'inside'));
    const result = await readMarkdownShare({ projectId: PROJECT, title: '', kind: 'book' });
    expect(result.markdown).toBe('# 合成书稿\n\n### Chapter preface\n\nOpening\n\n## Act One\n\n### Chapter inside\n\n#### Outline 1\n\n##### Outline 2\n\n###### Outline 3\n');
  });

  it('exports only the requested entity body and fails when its project does not match', async () => {
    const { db } = await fixture();
    await db.insert(ElementCategoryTable).values({ id: 'category', projectId: PROJECT, name: 'Category', color: '#123456', contentJson: prose('Category body'), createdAt: NOW, updatedAt: NOW });
    await db.insert(BookElementTable).values({ id: 'element', projectId: PROJECT, name: 'Element', categoryId: 'category', contentJson: prose('Element body'), createdAt: NOW, updatedAt: NOW });
    await db.insert(StorylineTable).values({ id: 'storyline', projectId: PROJECT, name: 'Storyline', color: '#123456', orderKey: 1, summary: 'PRIVATE SUMMARY', contentJson: prose('Storyline body'), createdAt: NOW, updatedAt: NOW });
    for (const kind of ['category', 'element', 'storyline'] as const) {
      const result = await readMarkdownShare({ projectId: PROJECT, title: '', kind, id: kind });
      expect(result.documentCount).toBe(1);
      expect(result.markdown).toBe(`# ${kind[0].toUpperCase()}${kind.slice(1)}\n\n${kind[0].toUpperCase()}${kind.slice(1)} body\n`);
    }
    await db.insert(ProjectTable).values({ id: 'other', name: 'Other', userId: 'synthetic', createdAt: NOW, updatedAt: NOW });
    await expect(readMarkdownShare({ projectId: 'other', title: '', kind: 'element', id: 'element' })).rejects.toThrow('no longer available');
  });

  it('fails the entire export on corrupt prose or cancellation instead of returning a partial book', async () => {
    const { db, node } = await fixture();
    await node('good', 1, 'Good'); await node('bad', 2, 'Bad');
    await db.update(NodeContentTable).set({ contentJson: '{invalid' }).where(eq(NodeContentTable.nodeId, 'bad'));
    await expect(readMarkdownShare({ projectId: PROJECT, title: '', kind: 'book' })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(readMarkdownShare({ projectId: PROJECT, title: '', kind: 'book' }, controller.signal)).rejects.toThrow();
  });

  it('keeps formatting and literal Markdown characters, without leaking entity IDs', () => {
    const result = proseToShareMarkdown(JSON.stringify({ type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'private-block' }, content: [
        { type: 'text', text: 'Literal *text* <tag> ' },
        { type: 'text', text: 'Name', marks: [{ type: 'entityLink', attrs: { targetId: 'private-entity', targetKind: 'element' } }, { type: 'bold' }] },
        { type: 'hardBreak' }, { type: 'text', text: '尾声 👩🏽‍🚀' },
      ] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] },
    ] }), 1);
    expect(result).toContain('\\*text\\*');
    expect(result).toContain('**Name**<br>尾声 👩🏽‍🚀');
    expect(result).toContain('> Quote');
    expect(result).not.toContain('private-');
    expect(result).toContain('\\<tag>');
    expect(new TextEncoder().encode(markdownShareFilename('长'.repeat(100))).length).toBeLessThan(160);
    expect(markdownShareFilename('../book/name')).toBe('-book-name.md');
  });

  it('wires a whole-book target separately from chapter actions and shows raw read-only Markdown', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../../views/AllChaptersEditorView.tsx')).toContain("shareTarget={{ projectId, kind: 'book', title: projectName }}");
    const dialog = source('../../components/editor/MarkdownShareDialog.tsx');
    expect(dialog).toContain('readOnly spellCheck={false}');
    expect(dialog).toContain('value={document.markdown}');
    expect(dialog).toContain('navigator.clipboard.writeText(document.markdown)');
    expect(dialog).toContain('platform.sharing.saveMarkdown(document.filename, document.markdown)');
    expect(dialog).toContain('textRef.current.select()');
    expect(dialog).not.toContain('dangerouslySetInnerHTML');
  });
});
