import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { installHeadlessDatabaseClient } from '../../lib/db';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { registerLiveYDoc } from '../../lib/yjs-doc-registry';
import { BookActTable, BookNodeTable, NodeContentTable, ProjectTable, yjsSnapshots, yjsUpdates } from '../../schema/drizzle';
import { readManuscript, readManuscriptOutline } from './manuscript-export.service';
import {
  defaultManuscriptChapterIds, manuscriptFilename, proseToManuscriptBlocks,
  type ManuscriptExportOptions, type ManuscriptSection,
} from './manuscript-export';

const PROJECT = 'synthetic-manuscript-book';
const NOW = '2026-10-31T00:00:00.000Z';
const FIXTURE = new URL('../../../../src-tauri/src/manuscript_export/fixtures/sample-manuscript.json', import.meta.url);
const LABELS = { untitledChapter: '无标题章节', untitledAct: '未命名卷' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Inline = { type: string; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
const text = (value: string, ...marks: NonNullable<Inline['marks']>): Inline => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) });
const p = (...content: Inline[]) => ({ type: 'paragraph', attrs: { id: 'synthetic-block', textAlign: 'left', indent: 0 }, content });
const h = (level: number, value: string) => ({ type: 'heading', attrs: { level, id: `h${level}` }, content: [text(value)] });
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

/** Deterministic original filler so chapters span several PDF pages. */
const HAN = ['潮水退去以后', '码头上只剩下几盏马灯', '她沿着湿漉漉的石阶往下走', '风从海面上吹来，带着盐和铁锈的味道',
  '远处的雾笛响了三声', '守灯人说，这样的夜里最好不要出门', '可她还是把那封信揣进了怀里', '石墙上的青苔在灯下发亮'];
const LATIN = ['The harbour lamps went out one by one', 'a gull complained somewhere above the breakwater',
  'she counted the steps down to the water', 'the letter in her coat had gone soft with damp',
  'nobody on the quay looked up when the bell rang', 'the tide came in faster than the tables promised'];
const filler = (bank: string[], count: number, joiner: string, end: string) => Array.from({ length: count }, (_, index) =>
  p(text(Array.from({ length: 4 + (index % 3) }, (_, part) => bank[(index * 5 + part * 3) % bank.length]).join(joiner) + end)));

/** Synthetic chapters: CJK punctuation, mixed Latin, marks, links and outline headings. */
const CHAPTERS: { id: string; title: string; order: number; status?: string; prose: string }[] = [
  { id: 'c0', title: '序章　灯下', order: 1, prose: doc(
    p(),
    p(text('雾港的灯塔在午夜亮起，守灯人写下第一行字：“今夜无船。”')),
    p(text('她把信纸折成三折——又展开——再折好……'), { type: 'hardBreak' }, text('窗外，潮声一阵紧似一阵。')),
    p(),
  ) },
  { id: 'c1', title: '第一章　来信', order: 2, prose: doc(
    h(1, '一　雨夜'),
    h(2, '节拍：信使抵达'),
    p(text('信封上只写着《雾港来信》四个字，邮戳是二〇二六年十月。')),
    p(text('“你确定是寄给我的吗？”她问。'), text('信使', { type: 'bold' }), text('没有回答，只把'),
      text('Drifting 2026', { type: 'italic' }), text('字样的徽章翻了过来。')),
    { type: 'blockquote', content: [p(text('见字如面：港口的雾，今年来得早了些。'))] },
    h(3, '注记：核对潮汐表'),
    p(text('她在页边画了一道'), text('下划线', { type: 'underline' }), text('，又把旧地址'),
      text('划掉', { type: 'strike' }), text('。')),
    { type: 'horizontalRule' },
    h(1, '二　旧信'),
    p(text('参见'), text('雾港志', { type: 'link', attrs: { href: 'https://example.com/fog-harbor' } }),
      text('与'), text('内部条目', { type: 'link', attrs: { href: 'drifting://element/private' } }),
      text('，以及'), text('林岚', { type: 'entityLink', attrs: { targetId: 'private-element', targetKind: 'element' } }), text('的回信。')),
  ) },
  { id: 'c2', title: '第二章　旧港', order: 3, prose: doc(
    p(text('码头上的人说：「雾散之前，不要出海。」（这句话她听过很多遍。）')),
    { ...p(text('——完——')), attrs: { id: 'centered', textAlign: 'center', indent: 0 } },
    { ...p(text('附：潮汐表见第三页。')), attrs: { id: 'indented', textAlign: 'left', indent: 1 } },
    ...filler(HAN, 28, '，', '。'),
  ) },
  { id: 'c3', title: '废稿　不应出现', order: 3.2, status: 'discarded', prose: doc(p(text('PRIVATE DISCARDED'))) },
  { id: 'c4', title: '第三章　返航', order: 4, prose: doc(
    p(text('It was past midnight when the ship came home; nobody said a word.')),
    p(text('船靠岸时，天已经亮了。')),
    ...filler(LATIN, 10, ', and ', '.'),
  ) },
];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-manuscript-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  cleanups.push(installHeadlessDatabaseClient(db, 'synthetic-manuscript.db'));
  await db.insert(ProjectTable).values({ id: PROJECT, name: '雾港来信（合成样书）', userId: 'synthetic', createdAt: NOW, updatedAt: NOW });
  for (const chapter of CHAPTERS) {
    await db.insert(BookNodeTable).values({ id: chapter.id, projectId: PROJECT, title: chapter.title, bookOrder: chapter.order,
      kind: 'chapter', writingStatus: chapter.status ?? 'draft', summary: 'PRIVATE SUMMARY', positionX: 0, positionY: 0,
      createdAt: NOW, updatedAt: NOW });
    await db.insert(NodeContentTable).values({ nodeId: chapter.id, contentJson: chapter.prose,
      plotGridJson: '{"private":"PLAN"}', createdAt: NOW, updatedAt: NOW });
  }
  await db.insert(BookNodeTable).values({ id: 'drift', projectId: PROJECT, title: 'PRIVATE DRIFT', bookOrder: null, kind: 'drift',
    summary: '', positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
  await db.insert(NodeContentTable).values({ nodeId: 'drift', contentJson: doc(p(text('PRIVATE DRIFT'))), createdAt: NOW, updatedAt: NOW });
  await db.insert(BookNodeTable).values({ id: 'trash', projectId: PROJECT, title: 'PRIVATE TRASH', bookOrder: 2.5, kind: 'chapter',
    summary: '', positionX: 0, positionY: 0, deletedAt: NOW, createdAt: NOW, updatedAt: NOW });
  await db.insert(BookActTable).values([
    { id: 'act-1', projectId: PROJECT, name: '第一卷　潮起', startOrder: 1.5, createdAt: NOW, updatedAt: NOW },
    { id: 'act-2', projectId: PROJECT, name: '第二卷　雾散', startOrder: 3.5, createdAt: NOW, updatedAt: NOW },
  ]);
  return { db };
}

const OPTIONS: ManuscriptExportOptions = {
  chapterIds: null, actTitles: true, chapterTitles: true, outlineHeadings: false,
  title: '', author: '合成作者', cover: null,
};
const CONTEXT = { locale: 'zh-CN', now: new Date('2026-10-31T08:00:00.000Z') };
const structure = (sections: ManuscriptSection[]) => sections.map(section => `${section.kind}:${section.title}`);

describe('manuscript export acceptance', () => {
  it('reads the whole book in act/chapter order without discarded, drift, trashed or planning content', async () => {
    await fixture();
    const outline = await readManuscriptOutline(PROJECT);
    expect(outline.chapters.map(chapter => [chapter.id, chapter.actId])).toEqual([
      ['c0', null], ['c1', 'act-1'], ['c2', 'act-1'], ['c3', 'act-1'], ['c4', 'act-2']]);
    expect(defaultManuscriptChapterIds(outline.chapters)).toEqual(['c0', 'c1', 'c2', 'c4']);

    const book = await readManuscript(PROJECT, OPTIONS, LABELS, CONTEXT);
    expect(book).toMatchObject({ title: '雾港来信（合成样书）', author: '合成作者', identifier: PROJECT,
      modified: '2026-10-31T08:00:00Z', locale: 'zh-CN' });
    expect(structure(book.sections)).toEqual(['chapter:序章　灯下', 'act:第一卷　潮起', 'chapter:第一章　来信',
      'chapter:第二章　旧港', 'act:第二卷　雾散', 'chapter:第三章　返航']);
    const serialized = JSON.stringify(book);
    expect(serialized).not.toMatch(/PRIVATE|PLAN|节拍：|注记：|drifting:\/\/|private-element/);
    expect(serialized).toContain('“今夜无船。”');
    expect(serialized).toContain('——又展开——再折好……');
    expect(serialized).toContain('「雾散之前，不要出海。」（这句话她听过很多遍。）');
  });

  it('maps prose to scene headings, marked runs, quotes, scene breaks, alignment and indent', async () => {
    await fixture();
    const book = await readManuscript(PROJECT, OPTIONS, LABELS, CONTEXT);
    const chapter = (title: string) => book.sections.find(section => section.title === title);
    const opening = chapter('序章　灯下');
    expect(opening).toMatchObject({ kind: 'chapter', showTitle: true });
    // Leading and trailing empty paragraphs are trimmed; hard breaks stay.
    expect(opening?.kind === 'chapter' && opening.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: '雾港的灯塔在午夜亮起，守灯人写下第一行字：“今夜无船。”' }] },
      { type: 'paragraph', runs: [{ text: '她把信纸折成三折——又展开——再折好……\n窗外，潮声一阵紧似一阵。' }] },
    ]);
    const first = chapter('第一章　来信');
    expect(first?.kind === 'chapter' && first.blocks.map(block => block.type)).toEqual([
      'heading', 'paragraph', 'paragraph', 'quote', 'paragraph', 'break', 'heading', 'paragraph']);
    expect(first?.kind === 'chapter' && first.blocks[2]).toEqual({ type: 'paragraph', runs: [
      { text: '“你确定是寄给我的吗？”她问。' }, { text: '信使', bold: true }, { text: '没有回答，只把' },
      { text: 'Drifting 2026', italic: true }, { text: '字样的徽章翻了过来。' }] });
    expect(first?.kind === 'chapter' && first.blocks[7]).toEqual({ type: 'paragraph', runs: [
      { text: '参见' }, { text: '雾港志', href: 'https://example.com/fog-harbor' }, { text: '与内部条目，以及林岚的回信。' }] });
    const second = chapter('第二章　旧港');
    expect(second?.kind === 'chapter' && second.blocks.slice(1, 3)).toEqual([
      { type: 'paragraph', runs: [{ text: '——完——' }], align: 'center' },
      { type: 'paragraph', runs: [{ text: '附：潮汐表见第三页。' }], indent: 1 },
    ]);
  });

  it('honours chapter selection, hidden act and chapter titles and optional outline headings', async () => {
    await fixture();
    const selected = await readManuscript(PROJECT, { ...OPTIONS, chapterIds: ['c4', 'c3', 'c1'], actTitles: false,
      chapterTitles: false, outlineHeadings: true, title: '  自定书名  ' }, LABELS, CONTEXT);
    expect(selected.title).toBe('自定书名');
    // Book order, not selection order; an explicitly chosen discarded chapter is included.
    expect(structure(selected.sections)).toEqual(['chapter:第一章　来信', 'chapter:废稿　不应出现', 'chapter:第三章　返航']);
    expect(selected.sections.every(section => section.kind === 'chapter' && !section.showTitle)).toBe(true);
    const first = selected.sections[0];
    expect(first.kind === 'chapter' && first.blocks.filter(block => block.type === 'heading')
      .map(block => block.type === 'heading' && [block.level, block.runs[0]?.text])).toEqual([
      [1, '一　雨夜'], [2, '节拍：信使抵达'], [3, '注记：核对潮汐表'], [1, '二　旧信']]);
    const withActs = await readManuscript(PROJECT, { ...OPTIONS, chapterIds: ['c4'] }, LABELS, CONTEXT);
    expect(structure(withActs.sections)).toEqual(['act:第二卷　雾散', 'chapter:第三章　返航']);
    await expect(readManuscript(PROJECT, { ...OPTIONS, chapterIds: [] }, LABELS, CONTEXT)).rejects.toThrow('No chapters');
  });

  it('uses live CRDT (even empty), persisted snapshot plus update, and the seed only without Yjs state', async () => {
    const { db } = await fixture();
    const seed = await createYjsProseSeedState(doc(p(text('Canonical'))));
    const live = new Y.Doc(); Y.applyUpdate(live, seed); cleanups.push(() => live.destroy());
    const updates: Uint8Array[] = [];
    live.on('update', update => updates.push(update));
    const body = (live.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    body.insert(body.length, ' persisted tail');
    for (const id of ['c0', 'c1', 'c2']) {
      await db.insert(yjsSnapshots).values({ docId: `node-content:${id}`, stateBlob: seed, updatedAt: NOW });
      await db.insert(yjsUpdates).values({ docId: `node-content:${id}`, updateBlob: updates[0], createdAt: NOW });
    }
    body.insert(body.length, ' UNSAVED live tail');
    cleanups.push(registerLiveYDoc('node-content:c0', live));
    const empty = new Y.Doc(); cleanups.push(() => empty.destroy());
    cleanups.push(registerLiveYDoc('node-content:c1', empty));
    const book = await readManuscript(PROJECT, { ...OPTIONS, actTitles: false }, LABELS, CONTEXT);
    const blocks = Object.fromEntries(book.sections.map(section => [section.title,
      section.kind === 'chapter' ? JSON.stringify(section.blocks) : '']));
    expect(blocks['序章　灯下']).toContain('Canonical persisted tail UNSAVED live tail');
    expect(blocks['第一章　来信']).toBe('[]');
    expect(blocks['第二章　旧港']).toContain('Canonical persisted tail');
    expect(blocks['第二章　旧港']).not.toContain('UNSAVED');
    expect(blocks['第三章　返航']).toContain('船靠岸时');
  });

  it('fails the whole export on corrupt prose or cancellation instead of returning a partial book', async () => {
    const { db } = await fixture();
    await db.update(NodeContentTable).set({ contentJson: '{invalid' }).where(eq(NodeContentTable.nodeId, 'c2'));
    await expect(readManuscript(PROJECT, OPTIONS, LABELS, CONTEXT)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(readManuscript(PROJECT, OPTIONS, LABELS, CONTEXT, controller.signal)).rejects.toThrow();
    expect(() => proseToManuscriptBlocks('[]', false)).toThrow('Invalid prose document');
    expect(proseToManuscriptBlocks('{}', false)).toEqual([]);
    expect(manuscriptFilename('../雾港/来信', 'epub')).toBe('-雾港-来信.epub');
    expect(new TextEncoder().encode(manuscriptFilename('长'.repeat(100), 'docx')).length).toBeLessThan(160);
  });

  it('keeps the native sample manuscript fixture equal to this converter output', async () => {
    await fixture();
    const book = await readManuscript(PROJECT, OPTIONS, LABELS, CONTEXT);
    const expected = `${JSON.stringify(book, null, 2)}\n`;
    if (process.env.DRIFTING_UPDATE_MANUSCRIPT_FIXTURE === '1') writeFileSync(FIXTURE, expected);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(expected);
  });

  it('opens the export dialog from the whole-book and chapter menus', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../../views/AllChaptersEditorView.tsx')).toContain('manuscriptExport={{ projectId }}');
    expect(source('../../views/NodeEditorView.tsx'))
      .toContain("manuscriptExport={curNode.kind === 'chapter' ? { projectId, chapterId: curNode.id } : undefined}");
    const dialog = source('../../components/editor/ManuscriptExportDialog.tsx');
    expect(dialog).toContain('platform.sharing.saveManuscript(');
    expect(dialog).toContain('readManuscript(target.projectId');
    expect(dialog).not.toContain('dangerouslySetInnerHTML');
  });
});
