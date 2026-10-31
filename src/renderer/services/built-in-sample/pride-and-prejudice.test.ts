// Content checks for the built-in sample's book and showcase. The source EPUB
// is not in the repository; set SAMPLE_BOOK_EPUB to its path to also rebuild
// the bundled files from it and compare them byte for byte.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validateRelationAgainstType, normalizeRelationTypeDefinition } from '../../domain/entity-relation-type';
import { anchorQuotation, BOOK_CHAPTERS, BOOK_ILLUSTRATIONS, BOOK_TEXT_SHA256, buildProseDocument, paragraphText } from './book';
import * as showcase from './showcase';

const directory = fileURLToPath(new URL('./pride-and-prejudice/', import.meta.url));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let ids = 0;
const newId = () => `block-${++ids}`;
const documentFor = (chapter: number) => buildProseDocument(BOOK_CHAPTERS[chapter - 1].blocks, newId);
const paragraphs = (chapter: number) =>
  BOOK_CHAPTERS[chapter - 1].blocks.flatMap((block) => typeof block === 'string' ? [block] : [...block]).map(paragraphText);

describe('the bundled book', () => {
  it('has the 61 chapters of the three volumes, in order', () => {
    expect(BOOK_CHAPTERS.map((chapter) => chapter.number)).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
    expect(BOOK_CHAPTERS.slice(0, 4).map((chapter) => chapter.roman)).toEqual(['I', 'II', 'III', 'IV']);
    expect(BOOK_CHAPTERS.slice(-3).map((chapter) => chapter.roman)).toEqual(['LIX', 'LX', 'LXI']);
    expect(showcase.VOLUMES.map((volume) => volume.firstChapter)).toEqual([1, 24, 43]);
    const words = BOOK_CHAPTERS.flatMap((chapter) => paragraphs(chapter.number)).join(' ').split(/\s+/).length;
    expect(words).toBeGreaterThan(118_000);
    expect(words).toBeLessThan(126_000);
  });

  it('matches the source text in spot-checked chapters', () => {
    expect(paragraphs(1)[0]).toBe('It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.');
    expect(BOOK_CHAPTERS[0].blocks[7]).toBe('“*You* want to tell me, and I have no objection to hearing it.”');
    expect(paragraphs(1)).toHaveLength(34);
    expect(paragraphs(3)).toContain('“Which do you mean?” and turning round, he looked for a moment at Elizabeth, till, catching her eye, he withdrew his own, and coldly said, “She is tolerable: but not handsome enough to tempt me; and I am in no humour at present to give consequence to young ladies who are slighted by other men. You had better return to your partner and enjoy her smiles, for you are wasting your time with me.”');
    // Mr. Collins's letter is set off as a block quote, signature and all.
    const letter = BOOK_CHAPTERS[12].blocks.find((block) => typeof block !== 'string') as readonly string[];
    expect(letter[0]).toBe('“Hunsford, near Westerham, Kent, *15th October*.');
    expect(letter[letter.length - 1]).toBe('“William Collins.”');
    expect(paragraphs(34)[3].startsWith('“In vain have I struggled. It will not do. My feelings will not be repressed. You must allow me to tell you how ardently I admire and love you.”')).toBe(true);
    expect(paragraphs(35)[3]).toBe('“Be not alarmed, madam, on receiving this letter, by the apprehension of its containing any repetition of those sentiments, or renewal of those offers, which were last night so disgusting to you. I write without any intention of paining you, or humbling myself, by dwelling on wishes, which, for the happiness of both, cannot be too soon forgotten; and the effort which the formation and the perusal of this letter must occasion, should have been spared, had not my character required it to be written and read. You must, therefore, pardon the freedom with which I demand your attention; your feelings, I know, will bestow it unwillingly, but I demand it of your justice.');
    const lydia = BOOK_CHAPTERS[46].blocks.flatMap((block) => typeof block === 'string' ? [block] : [...block]);
    expect(lydia.find((paragraph) => paragraph.includes('Lydia Bennet.”'))).toBe('“Your affectionate friend,\n“Lydia Bennet.”');
    expect(paragraphs(61).slice(-1)[0]).toBe('With the Gardiners they were always on the most intimate terms. Darcy, as well as Elizabeth, really loved them; and they were both ever sensible of the warmest gratitude towards the persons who, by bringing her into Derbyshire, had been the means of uniting them.');
  });

  it('carries no trace of the digital library it was transcribed from', () => {
    for (const file of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, file));
      expect(/gutenberg/i.test(bytes.toString('latin1')), file).toBe(false);
    }
    expect(JSON.stringify(showcase)).not.toMatch(/gutenberg/i);
    const text = JSON.stringify(BOOK_CHAPTERS);
    for (const leftover of ['CHISWICK', 'Copyright', '[Illustration', 'CHAPTER']) expect(text).not.toContain(leftover);
  });

  it('ships exactly the files its manifest describes, within the size budget', () => {
    expect(sha256(readFileSync(join(directory, 'text.json')))).toBe(BOOK_TEXT_SHA256);
    const referenced = new Set(['text.json', 'manifest.json', 'README.md']);
    for (const illustration of BOOK_ILLUSTRATIONS) {
      const source = readFileSync(join(directory, illustration.source));
      expect(sha256(source), illustration.name).toBe(illustration.sha256);
      expect(source.byteLength).toBe(illustration.sizeBytes);
      expect(Math.max(illustration.width, illustration.height)).toBeLessThanOrEqual(1600);
      for (const variant of Object.values(illustration.variants)) {
        expect(sha256(readFileSync(join(directory, variant.file))), variant.file).toBe(variant.sha256);
        referenced.add(variant.file);
      }
      referenced.add(illustration.source);
    }
    expect(new Set(readdirSync(directory))).toEqual(referenced);
    const bytes = [...referenced].reduce((sum, file) => sum + statSync(join(directory, file)).size, 0);
    expect(bytes).toBeLessThan(1_600_000);
  });

  it.skipIf(!process.env.SAMPLE_BOOK_EPUB)('is reproduced exactly from the source EPUB', () => {
    const out = mkdtempSync(join(tmpdir(), 'drifting-sample-book-'));
    try {
      const script = fileURLToPath(new URL('../../../../scripts/build-sample-book.py', import.meta.url));
      execFileSync('python3', ['-I', script, process.env.SAMPLE_BOOK_EPUB!, '--out', out], { stdio: 'pipe' });
      for (const file of readdirSync(out)) {
        expect(sha256(readFileSync(join(out, file))), file).toBe(sha256(readFileSync(join(directory, file))));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('the showcase', () => {
  it('plans every chapter on known storylines', () => {
    expect(showcase.CHAPTER_PLANS).toHaveLength(61);
    const keys = new Set(showcase.STORYLINES.map((storyline) => storyline.key));
    for (const [index, plan] of showcase.CHAPTER_PLANS.entries()) {
      expect(plan.storylines.length, `chapter ${index + 1}`).toBeGreaterThan(0);
      expect(new Set(plan.storylines).size).toBe(plan.storylines.length);
      for (const key of plan.storylines) expect(keys.has(key)).toBe(true);
      expect(plan.summary.length).toBeLessThan(160);
    }
  });

  it('anchors every quotation to exactly one plain paragraph of its chapter', () => {
    for (const item of [...showcase.ELEMENT_PATCHES, ...showcase.COMMENTS.filter((comment) => comment.chapter)]) {
      const anchor = anchorQuotation(documentFor(item.chapter!), item.quotation!);
      expect(anchor.blockText.slice(anchor.from, anchor.to)).toBe(item.quotation);
    }
    expect(() => anchorQuotation(documentFor(1), 'a single man')).not.toThrow();
    expect(() => anchorQuotation(documentFor(1), 'Mr. Bennet')).toThrow('occur once');
  });

  it('keeps element names and aliases unique, and relations valid for their types', () => {
    const names = showcase.ELEMENTS.flatMap((element) => [element.name, ...element.aliases]).map((name) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const elements = new Set(showcase.ELEMENTS.map((element) => element.key));
    const types = new Map(showcase.RELATION_TYPES.map((type) => [type.key, {
      id: type.key, projectId: 'p', ...normalizeRelationTypeDefinition({ ...type, sourceKinds: [...type.sourceKinds], targetKinds: [...type.targetKinds] }),
      systemKey: null, locked: false, createdAt: '', updatedAt: '',
    }]));
    const edges = new Set<string>();
    for (const relation of showcase.RELATIONS) {
      expect(elements.has(relation.from), relation.from).toBe(true);
      const toKind = typeof relation.to === 'number' ? 'node' : 'element';
      if (typeof relation.to !== 'number') expect(elements.has(relation.to), relation.to).toBe(true);
      const checked = validateRelationAgainstType(types.get(relation.type)!, {
        fromKind: 'element', fromId: relation.from, toKind, toId: String(relation.to),
      });
      expect(checked.ok, `${relation.type} ${relation.from} → ${relation.to}`).toBe(true);
      const key = JSON.stringify(checked.ok ? [relation.type, checked.relation.fromId, checked.relation.toId] : null);
      expect(edges.has(key), key).toBe(false);
      edges.add(key);
    }
    for (const patch of showcase.ELEMENT_PATCHES) expect(elements.has(patch.element)).toBe(true);
    expect(new Set(showcase.ELEMENT_PATCHES.map((patch) => patch.element)).size).toBe(showcase.ELEMENT_PATCHES.length);
  });

  it('pins the timeline in order and names an illustration for every portrait and material', () => {
    const pins = showcase.TIMELINE_PINS.map((pin) => pin.beforeChapter);
    expect(pins).toEqual([...pins].sort((a, b) => a - b));
    for (const element of showcase.ELEMENTS.filter((candidate) => candidate.portrait))
      expect(BOOK_ILLUSTRATIONS.some((item) => item.name === element.portrait && item.use === 'portrait')).toBe(true);
    for (const illustration of BOOK_ILLUSTRATIONS.filter((item) => item.use === 'material'))
      expect(showcase.ILLUSTRATION_NOTES[illustration.name], illustration.name).toBeTruthy();
    expect(showcase.PLOT_GRID.rows.every((row) => row.cells.length === showcase.PLOT_GRID.columns.length)).toBe(true);
  });
});
