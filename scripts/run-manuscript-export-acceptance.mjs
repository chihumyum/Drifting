#!/usr/bin/env node
// Exports the synthetic sample book as EPUB, Word and PDF through the native
// writers and records what independent readers find in the files:
// poppler (pdfinfo/pdffonts/pdftotext/pdfimages) for the PDF, macOS
// textutil for the Word package, the EPUB container itself, and epubcheck
// when EPUBCHECK_JAR points at a local jar. `--check` verifies freshness.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = 'docs/acceptance/manuscript-export.json';
const sourceFiles = [
  'scripts/run-manuscript-export-acceptance.mjs',
  'src/renderer/services/export/manuscript-export.ts',
  'src/renderer/services/export/manuscript-export.service.ts',
  'src/renderer/services/export/manuscript-export.acceptance.test.ts',
  'src-tauri/src/manuscript_export/mod.rs',
  'src-tauri/src/manuscript_export/text.rs',
  'src-tauri/src/manuscript_export/epub.rs',
  'src-tauri/src/manuscript_export/docx.rs',
  'src-tauri/src/manuscript_export/pdf/mod.rs',
  'src-tauri/src/manuscript_export/pdf/fonts.rs',
  'src-tauri/src/manuscript_export/pdf/layout.rs',
  'src-tauri/src/manuscript_export/acceptance.rs',
  'src-tauri/src/manuscript_export/fixtures/sample-manuscript.json',
];
/** Acts and chapters of the sample in reading order. */
const ORDER = ['序章　灯下', '第一卷　潮起', '第一章　来信', '第二章　旧港', '第二卷　雾散', '第三章　返航'];
const PUNCTUATION = ['“今夜无船。”', '——又展开——再折好……', '「雾散之前，不要出海。」（这句话她听过很多遍。）', '《雾港来信》'];
const CLOSING = '，。、；：！？）」』】》〉”’';
const OPENING = '（「『【《〈“‘';

function fingerprint() {
  const hash = createHash('sha256');
  for (const file of sourceFiles) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/** Positions of each title in `text`, which must be strictly increasing. */
function inOrder(text, titles) {
  let from = 0;
  for (const title of titles) {
    const at = text.indexOf(title, from);
    if (at < 0) return false;
    from = at + title.length;
  }
  return true;
}
const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
}

async function inspectEpub(file) {
  const bytes = readFileSync(file);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  check('epub: uncompressed mimetype is the first entry without an extra field',
    bytes.readUInt16LE(8) === 0 && bytes.readUInt16LE(28) === 0
      && bytes.subarray(30, 58).toString('latin1') === 'mimetypeapplication/epub+zip');
  const opf = await zip.file('OEBPS/content.opf').async('string');
  const manifest = [...opf.matchAll(/<item id="([^"]+)" href="([^"]+)" media-type="([^"]+)"(?: properties="([^"]+)")?\/>/g)]
    .map(([, id, href, type, properties]) => ({ id, href: `OEBPS/${href}`, type, properties: properties ?? '' }));
  check('epub: every manifest item exists and every file is declared',
    manifest.every(item => names.includes(item.href))
      && names.every(name => ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf'].includes(name)
        || manifest.some(item => item.href === name)));
  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  const toc = nav.slice(nav.indexOf('epub:type="toc"'), nav.indexOf('</nav>'));
  const navTitles = [...toc.matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)].map(match => match[1]);
  check('epub: navigation document lists acts and chapters in book order', JSON.stringify(navTitles) === JSON.stringify(ORDER), navTitles);
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map(match => manifest.find(item => item.id === match[1]).href);
  let body = '';
  for (const href of spine) body += await zip.file(href).async('string');
  check('epub: spine reads titles, then contents, then the body in order', inOrder(body, ['雾港来信（合成样书）', '目录', ...ORDER]));
  check('epub: CJK punctuation survives verbatim', PUNCTUATION.every(fragment => body.includes(fragment)));
  check('epub: beat/note headings, drifts, discarded chapters and private links stay out',
    !/节拍：|注记：|PRIVATE|drifting:\/\//.test(body));
  const cover = manifest.find(item => item.properties.includes('cover-image'));
  check('epub: cover image is declared and is a JPEG', cover?.type === 'image/jpeg'
    && (await zip.file(cover.href).async('nodebuffer')).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
  check('epub: metadata names the title, author, language and modification time',
    opf.includes('<dc:title>雾港来信（合成样书）</dc:title>') && opf.includes('<dc:creator>合成作者</dc:creator>')
      && opf.includes('<dc:language>zh-CN</dc:language>') && opf.includes('<meta property="dcterms:modified">2026-10-31T08:00:00Z</meta>'));
  let epubcheck = { run: false, reason: 'EPUBCHECK_JAR is not set' };
  if (process.env.EPUBCHECK_JAR && existsSync(process.env.EPUBCHECK_JAR)) {
    const result = spawnSync('java', ['-jar', process.env.EPUBCHECK_JAR, file], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    const version = spawnSync('java', ['-jar', process.env.EPUBCHECK_JAR, '--version'], { encoding: 'utf8' }).stdout.trim();
    epubcheck = { run: true, version, exitCode: result.status, summary: output.split('\n').filter(line => /Messages:|No errors/.test(line)) };
    check('epub: W3C epubcheck reports no fatals, errors or warnings', result.status === 0
      && epubcheck.summary.some(line => line.includes('0 fatals / 0 errors / 0 warnings')), epubcheck.summary);
  }
  return { bytes: bytes.length, sha256: sha256(bytes), files: names.length, spine: spine.length, epubcheck };
}

async function inspectDocx(file) {
  const bytes = readFileSync(file);
  const zip = await JSZip.loadAsync(bytes);
  const document = await zip.file('word/document.xml').async('string');
  const headings = [...document.matchAll(/<w:pStyle w:val="(Heading\d|Title|Subtitle)"\/>.*?<\/w:pPr>(.*?)<\/w:p>/g)]
    .map(([, style, runs]) => [style, [...runs.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(match => match[1]).join('')]);
  check('docx: acts are Heading 1, chapters Heading 2 and scenes Heading 3, in book order',
    JSON.stringify(headings.filter(([style]) => style.startsWith('Heading')).map(([style, text]) => `${style}:${text}`))
      === JSON.stringify(['Heading2:序章　灯下', 'Heading1:第一卷　潮起', 'Heading2:第一章　来信', 'Heading3:一　雨夜',
        'Heading3:二　旧信', 'Heading2:第二章　旧港', 'Heading1:第二卷　雾散', 'Heading2:第三章　返航']), headings);
  const text = run('textutil', ['-convert', 'txt', '-stdout', file]);
  check('docx: macOS textutil opens the package and reads the book in order', inOrder(text, ['雾港来信（合成样书）', '合成作者', ...ORDER]));
  check('docx: CJK punctuation survives verbatim', PUNCTUATION.every(fragment => text.includes(fragment)));
  check('docx: bold, italic, underline, strike and the web link are kept',
    /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">信使</.test(document) && document.includes('<w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">Drifting 2026<')
      && document.includes('<w:u w:val="single"/></w:rPr><w:t xml:space="preserve">下划线<') && document.includes('<w:strike/></w:rPr><w:t xml:space="preserve">划掉<')
      && (await zip.file('word/_rels/document.xml.rels').async('string')).includes('Target="https://example.com/fog-harbor" TargetMode="External"'));
  check('docx: the cover picture is embedded', document.includes('r:embed="rIdCover"') && !!zip.file('word/media/cover.jpeg'));
  return { bytes: bytes.length, sha256: sha256(bytes), headings: headings.length, textutilCharacters: text.length };
}

function inspectPdf(file) {
  const info = run('pdfinfo', [file]);
  const field = name => info.match(new RegExp(`^${name}:\\s+(.*)$`, 'm'))?.[1];
  const pages = Number(field('Pages'));
  check('pdf: metadata names the title and author', field('Title') === '雾港来信（合成样书）' && field('Author') === '合成作者');
  check('pdf: A5 pages', field('Page size') === '419.53 x 595.28 pts');
  const fonts = run('pdffonts', [file]).split('\n').slice(2).filter(Boolean).map(line => {
    const columns = line.trim().split(/\s+/);
    return { name: columns[0], type: columns.slice(1, -6).join(' '), embedded: columns.at(-5) === 'yes', subset: columns.at(-4) === 'yes', unicode: columns.at(-3) === 'yes' };
  });
  check('pdf: every font is an embedded subset with a Unicode map', fonts.length > 0 && fonts.every(font => font.embedded && font.subset && font.unicode), fonts);
  const images = run('pdfimages', ['-list', file]).split('\n').slice(2).filter(Boolean);
  check('pdf: the cover is the one image, on page 1', images.length === 1 && /^\s*1\s/.test(images[0]), images);
  // Content-stream order; poppler reports the ideographic space as a space.
  const text = run('pdftotext', ['-raw', '-enc', 'UTF-8', file, '-']);
  const titles = ORDER.map(title => title.replace(/\u3000/g, ' '));
  check('pdf: extracted text reads the title page, contents and body in order', inOrder(text, ['雾港来信（合成样书）', '目录', ...titles, ...titles]));
  check('pdf: CJK punctuation is extractable verbatim', PUNCTUATION.every(fragment => text.replace(/\n/g, '').includes(fragment)));
  check('pdf: beat/note headings, drifts and discarded chapters stay out', !/节拍：|注记：|PRIVATE|不应出现/.test(text));
  // Line-by-line layout: no line begins with a closing mark or ends with an opening one.
  const layout = run('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-']).split('\n').map(line => line.trim()).filter(Boolean);
  const startsBadly = layout.filter(line => CLOSING.includes(line[0]));
  const endsBadly = layout.filter(line => OPENING.includes(line.at(-1)));
  check('pdf: line breaking keeps closing marks off line starts and opening marks off line ends',
    startsBadly.length === 0 && endsBadly.length === 0, { startsBadly, endsBadly });
  const pageNumbers = run('pdftotext', ['-enc', 'UTF-8', '-f', '4', '-l', String(pages), '-layout', file, '-'])
    .split('\f').filter(page => page.trim()).map(page => page.trim().split('\n').at(-1).trim());
  check('pdf: body pages carry footer numbers from 1', pageNumbers.every((number, index) => number === String(index + 1)), pageNumbers);
  return { bytes: readFileSync(file).length, pages, fonts, lines: layout.length };
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint(), 'Manuscript export acceptance is stale; rerun node scripts/run-manuscript-export-acceptance.mjs');
  console.log(`Manuscript export evidence matches current source (${report.checks.length} checks).`);
} else {
  for (const tool of ['pdfinfo', 'pdffonts', 'pdftotext', 'pdfimages', 'textutil']) {
    assert.equal(spawnSync('which', [tool]).status, 0, `${tool} is required (poppler and macOS textutil)`);
  }
  const before = fingerprint();
  const vitest = spawnSync('pnpm', ['exec', 'vitest', 'run', 'src/renderer/services/export/manuscript-export.acceptance.test.ts', '--reporter=dot'], { stdio: 'inherit' });
  assert.equal(vitest.status, 0, 'The renderer converter no longer produces the sample fixture');
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-manuscript-'));
  try {
    const cargo = spawnSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
      'manuscript_export::acceptance::write_sample_outputs', '--', '--ignored', '--exact'], {
      stdio: 'inherit', env: { ...process.env, DRIFTING_MANUSCRIPT_OUT: directory },
    });
    assert.equal(cargo.status, 0, 'Native writers failed on the sample book');
    const timings = Object.fromEntries(['epub', 'docx', 'pdf'].map(format =>
      [format, Number(readFileSync(path.join(directory, `sample.${format}.ms`), 'utf8'))]));
    const outputs = {
      epub: await inspectEpub(path.join(directory, 'sample.epub')),
      docx: await inspectDocx(path.join(directory, 'sample.docx')),
      pdf: { ...inspectPdf(path.join(directory, 'sample.pdf')), fontsChosen: JSON.parse(readFileSync(path.join(directory, 'fonts.json'), 'utf8')) },
    };
    assert.equal(before, fingerprint(), 'Manuscript export source changed during acceptance');
    const failed = checks.filter(entry => !entry.passed);
    const krilla = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/name = "krilla"\nversion = "([^"]+)"/)?.[1];
    writeFileSync(reportPath, `${JSON.stringify({
      kind: 'manuscript-export-sample-book', generatedAt: new Date().toISOString(), sourceSha256: before,
      status: failed.length ? 'failed' : 'passed', synthetic: true,
      platform: `${process.platform}-${process.arch}`, krilla,
      debugBuildMilliseconds: timings, outputs, checks,
      boundaries: {
        sample: 'synthetic book from manuscript-export.acceptance.test.ts: one pre-act chapter, two acts, a discarded chapter, a drift, a trashed chapter, scene/beat/note headings, marks, links, quote, scene break, hard break and a generated cover',
        epubcheck: 'the W3C epubcheck jar runs only when EPUBCHECK_JAR is set; otherwise the Rust test checks the OCF, package, navigation, NCX and XHTML rules it enforces',
        word: 'macOS textutil and the Rust test parse the package; Microsoft Word itself is not driven',
        pdfFonts: 'installed system fonts of the machine that ran this report; another computer may pick other faces from the same lists',
        ui: 'the export dialog is covered by its own desktop acceptance notes in docs/manuscript-export.md',
      },
    }, null, 2)}\n`);
    console.log(`${checks.length - failed.length}/${checks.length} manuscript export checks passed.`);
    assert.equal(failed.length, 0, failed.map(entry => entry.name).join('\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
