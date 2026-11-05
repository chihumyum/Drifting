// Content checks for the second built-in sample, 阿Q正传. The Wikisource
// response it is built from is not in the repository; set A_Q_WIKISOURCE_JSON
// to its path (README in ./a-q/) to also rebuild text.json and compare it byte
// for byte.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeRelationTypeDefinition, validateRelationAgainstType } from '../../domain/entity-relation-type';
import { A_Q_CHAPTERS, A_Q_ZHENGZHUAN as book } from './a-q';
import { anchorQuotation, buildProseDocument, createEntityLinker } from './book';

const directory = fileURLToPath(new URL('./a-q/', import.meta.url));
let ids = 0;
const documentFor = (chapter: number) => buildProseDocument(A_Q_CHAPTERS[chapter - 1].blocks, () => `block-${++ids}`);
const paragraphs = (chapter: number) => A_Q_CHAPTERS[chapter - 1].blocks as string[];
const written = A_Q_CHAPTERS.slice(0, 6);

describe('the bundled text', () => {
  it('has the six written chapters and three planned ones', () => {
    expect(A_Q_CHAPTERS.map((chapter) => chapter.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(A_Q_CHAPTERS.map((chapter) => book.chapterTitle(chapter.number))).toEqual([
      '第一章 序', '第二章 优胜记略', '第三章 续优胜记略', '第四章 恋爱的悲剧', '第五章 生计问题',
      '第六章 从中兴到末路', '第七章 革命', '第八章 不准革命', '第九章 大团圆',
    ]);
    expect(A_Q_CHAPTERS.slice(6).map((chapter) => chapter.blocks)).toEqual([[''], [''], ['']]);
    expect(written.map((chapter) => chapter.blocks.length)).toEqual([13, 29, 40, 45, 29, 32]);
    const characters = written.flatMap((chapter) => paragraphs(chapter.number)).join('').length;
    expect(characters).toBeGreaterThan(13_000);
    expect(characters).toBeLessThan(14_000);
    expect(statSync(join(directory, 'text.json')).size).toBeLessThan(48 * 1024);
  });

  it('matches the source in spot-checked paragraphs, with its errata applied', () => {
    expect(paragraphs(1)[0]).toBe('我要给阿Q做正传，已经不止一两年了。但一面要做，一面又往回想，这足见我不是一个“立言”的人，因为从来不朽之笔，须传不朽之人，于是人以文传，文以人传——究竟谁靠谁传，渐渐的不甚了然起来，而终于归结到传阿Q，仿佛思想里有鬼似的。');
    expect(paragraphs(2)[1]).toBe('“我们先前——比你阔的多啦！你算是什么东西！”');
    expect(paragraphs(4)[22]).toBe('“我和你困觉，我和你困觉！”阿Q忽然抢上去，对伊跪下了。');
    expect(paragraphs(6)[paragraphs(6).length - 1]).toMatch(/斯亦不足畏也矣”。$/);
    const text = written.flatMap((chapter) => paragraphs(chapter.number)).join('\n');
    for (const corrected of ['在精神上', '响了之后，于他倒', '“咳，呸！”', '是赵大爷未进秀才的时候', '看见赵大爷向他奔来', '皮肤有些起粟', '钱太爷和秀才大爷上城'])
      expect(text, corrected).toContain(corrected);
    // Modern quotation marks and characters; nothing left of the web page.
    expect(text).not.toMatch(/[『』「」偸\u200b<>]|编辑/);
  });
});

describe('the showcase', () => {
  it('plans every chapter on known storylines', () => {
    expect(book.chapterPlans).toHaveLength(9);
    const keys = new Set(book.storylines.map((storyline) => storyline.key));
    for (const [index, plan] of book.chapterPlans.entries()) {
      expect(plan.storylines.length, `chapter ${index + 1}`).toBeGreaterThan(0);
      expect(new Set(plan.storylines).size).toBe(plan.storylines.length);
      for (const key of plan.storylines) expect(keys.has(key)).toBe(true);
      expect(plan.summary.length).toBeLessThan(120);
    }
    expect(book.volumes.map((volume) => volume.firstChapter)).toEqual([1, 7]);
    expect(book.finishedChapters.every((number) => number <= 6)).toBe(true);
  });

  it('anchors every quotation to exactly one plain paragraph of a written chapter', () => {
    for (const item of [...book.elementPatches, ...book.comments.filter((comment) => comment.chapter)]) {
      expect(item.chapter!).toBeLessThanOrEqual(6);
      const anchor = anchorQuotation(documentFor(item.chapter!), item.quotation!);
      expect(anchor.blockText.slice(anchor.from, anchor.to)).toBe(item.quotation);
    }
    expect(() => anchorQuotation(documentFor(2), '阿Q')).toThrow('occur once');
  });

  it('keeps element names and aliases unique, and relations valid for their types', () => {
    const names = book.elements.flatMap((element) => [element.name, ...element.aliases]);
    expect(new Set(names).size).toBe(names.length);
    const elements = new Set(book.elements.map((element) => element.key));
    const categories = new Set(book.categories.map((category) => category.key));
    for (const element of book.elements) expect(categories.has(element.category), element.key).toBe(true);
    const types = new Map(book.relationTypes.map((type) => [type.key, {
      id: type.key, projectId: 'p', ...normalizeRelationTypeDefinition({ ...type, sourceKinds: [...type.sourceKinds], targetKinds: [...type.targetKinds] }),
      systemKey: null, locked: false, createdAt: '', updatedAt: '',
    }]));
    const edges = new Set<string>();
    for (const relation of book.relations) {
      expect(elements.has(relation.from), relation.from).toBe(true);
      const toKind = typeof relation.to === 'number' ? 'node' : 'element';
      if (typeof relation.to !== 'number') expect(elements.has(relation.to), relation.to).toBe(true);
      else expect(relation.to).toBeLessThanOrEqual(9);
      const checked = validateRelationAgainstType(types.get(relation.type)!, {
        fromKind: 'element', fromId: relation.from, toKind, toId: String(relation.to),
      });
      expect(checked.ok, `${relation.type} ${relation.from} → ${relation.to}`).toBe(true);
      const key = JSON.stringify(checked.ok ? [relation.type, checked.relation.fromId, checked.relation.toId] : null);
      expect(edges.has(key), key).toBe(false);
      edges.add(key);
    }
    for (const patch of book.elementPatches) expect(elements.has(patch.element)).toBe(true);
    for (const comment of book.comments.filter((item) => item.element)) expect(elements.has(comment.element!)).toBe(true);
  });

  it('pins the timeline in order and fills the plot grid', () => {
    const pins = book.timelinePins.map((pin) => pin.beforeChapter);
    expect(pins).toEqual([...pins].sort((a, b) => a - b));
    expect(book.plotGrid!.chapter).toBeLessThanOrEqual(6);
    expect(book.plotGrid!.rows.every((row) => row.cells.length === book.plotGrid!.columns.length)).toBe(true);
    expect(book.illustrations).toEqual([]);
  });
});

describe('the chapter links', () => {
  const linker = createEntityLinker(new Map(book.linkForms.map(({ form, element }) => [form, element])), 'none');
  const linked = (text: string) => linker(text).filter((run) => run.elementId).map((run) => [run.text, run.elementId]);

  it('point every linked form at an element of the sample', () => {
    const keys = new Set(book.elements.map((element) => element.key));
    for (const { form, element } of book.linkForms) if (element !== null) expect(keys.has(element), form).toBe(true);
    expect(new Set(book.linkForms.map(({ form }) => form)).size).toBe(book.linkForms.length);
  });

  it('tell the 秀才 from the rank, and leave the title and the 秀才’s wife plain', () => {
    expect(linked('那秀才便拿了一枝大竹杠')).toEqual([['秀才', 'zhao-xiucai']]);
    expect(linked('将来恐怕要变秀才者也；皇帝已经停了考，不要秀才和举人了')).toEqual([]);
    expect(linked('秀才娘子忙一瞥阿Q的脸')).toEqual([['阿Q', 'aq']]);
    expect(linked('但是我这阿Q正传到那时却又怕早经消灭了')).toEqual([]);
    expect(linked('人都叫他阿Quei，别人都叫他王癞胡，才知道他们有事都去叫小Don')).toEqual([
      ['阿Quei', 'aq'], ['王癞胡', 'wang-hu'], ['小Don', 'xiao-d'],
    ]);
  });

  it('link the people and places through the written chapters', () => {
    const counts = new Map<string, number>();
    for (const chapter of written) {
      for (const text of paragraphs(chapter.number)) {
        for (const run of linker(text)) if (run.elementId) counts.set(run.elementId, (counts.get(run.elementId) ?? 0) + 1);
      }
    }
    expect(counts.get('aq')).toBeGreaterThan(150);
    expect(counts.get('zhao-taiye')).toBeGreaterThan(20);
    expect(counts.get('weizhuang')).toBeGreaterThan(20);
    // 辫子 is a motif, not a name; it is left for the author to link.
    expect([...book.elements.map((element) => element.key)].filter((key) => !counts.has(key))).toEqual(['bianzi']);
  });
});

describe.skipIf(!process.env.A_Q_WIKISOURCE_JSON)('the source', () => {
  it('reproduces text.json exactly', () => {
    const out = mkdtempSync(join(tmpdir(), 'drifting-a-q-'));
    try {
      const script = fileURLToPath(new URL('../../../../scripts/build-a-q-sample.py', import.meta.url));
      execFileSync('python3', ['-I', script, process.env.A_Q_WIKISOURCE_JSON!, '--out', out], { stdio: 'pipe' });
      expect(readFileSync(join(out, 'text.json'))).toEqual(readFileSync(join(directory, 'text.json')));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
