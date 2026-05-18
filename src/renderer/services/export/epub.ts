/**
 * EPUB writer — hand-rolled.
 *
 * Why not `epub-gen-memory`: its dep tree (ejs/mime/diacritics/slugify/jszip)
 * doesn't bundle cleanly through Vite + pnpm strict isolation, and the
 * EPUB spec is small enough to do directly. We get a much smaller bundle
 * and full control over the output.
 *
 * EPUB structure produced here (EPUB 3.0 minimum viable):
 *   mimetype                        ← uncompressed, stored first
 *   META-INF/container.xml
 *   OEBPS/content.opf               ← package metadata + spine
 *   OEBPS/toc.xhtml                 ← EPUB3 nav doc
 *   OEBPS/chapter-{id}.xhtml        ← one per chapter
 */
import JSZip from 'jszip';
import type { Node as PMNode, Mark as PMMark } from '@tiptap/pm/model';
import type { BookInput, ExportContext, ExportResult, FormatWriter } from './types';

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ───── ProseMirror → XHTML body (a strict subset; no scripts) ─────

function renderInline(node: PMNode, ctx: ExportContext): string {
  let out = '';
  node.descendants((child) => {
    if (!child.isText) return true;
    let text = escapeXml(child.text ?? '');
    const marks = child.marks as readonly PMMark[];
    for (const m of marks) {
      const name = m.type.name;
      if (name === 'bold') text = `<strong>${text}</strong>`;
      else if (name === 'italic') text = `<em>${text}</em>`;
      else if (name === 'underline') text = `<u>${text}</u>`;
      else if (name === 'strike') text = `<s>${text}</s>`;
      else if (name === 'code') text = `<code>${text}</code>`;
      else if (name === 'entityLink' || name === 'link') {
        const targetKind = (m.attrs as { targetKind?: string })?.targetKind;
        const targetId = (m.attrs as { targetId?: string })?.targetId;
        if (targetKind && targetId && ctx.resolveLabel) {
          text = escapeXml(ctx.resolveLabel(targetKind as Parameters<typeof ctx.resolveLabel>[0], targetId));
        }
      }
    }
    out += text;
    return false;
  });
  return out;
}

function renderBlock(node: PMNode, ctx: ExportContext): string {
  const t = node.type.name;
  switch (t) {
    case 'paragraph':
      return `<p>${renderInline(node, ctx)}</p>`;
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number((node.attrs as { level?: number })?.level) || 1));
      return `<h${level}>${renderInline(node, ctx)}</h${level}>`;
    }
    case 'blockquote': {
      let inner = '';
      node.forEach((child) => {
        inner += renderBlock(child, ctx);
      });
      return `<blockquote>${inner}</blockquote>`;
    }
    case 'codeBlock':
      return `<pre><code>${escapeXml(node.textContent)}</code></pre>`;
    case 'bulletList': {
      let inner = '';
      node.forEach((item) => {
        inner += '<li>';
        item.forEach((c) => (inner += renderBlock(c, ctx)));
        inner += '</li>';
      });
      return `<ul>${inner}</ul>`;
    }
    case 'orderedList': {
      let inner = '';
      node.forEach((item) => {
        inner += '<li>';
        item.forEach((c) => (inner += renderBlock(c, ctx)));
        inner += '</li>';
      });
      return `<ol>${inner}</ol>`;
    }
    case 'horizontalRule':
      return '<hr/>';
    default: {
      let inner = '';
      node.forEach((c) => (inner += renderBlock(c, ctx)));
      return inner;
    }
  }
}

// ───── Static EPUB scaffolding (parts that don't depend on content) ─────

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// Minimal stylesheet — readable defaults, no shouting.
const STYLES_CSS = `@charset "UTF-8";
body { font-family: serif; line-height: 1.6; }
h1, h2, h3 { font-family: serif; line-height: 1.2; }
blockquote { margin: 0.6em 1.2em; color: #444; }
code { font-family: "JetBrains Mono", "SFMono-Regular", monospace; }
pre  { background: #f7f5ee; padding: 0.6em 1em; overflow-x: auto; }`;

function buildChapterXhtml(title: string, body: string, lang: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  ${body}
</body>
</html>`;
}

function buildContentOpf(book: BookInput, chapterIds: string[]): string {
  const uid = `urn:drifting:${chapterIds[0] ?? 'book'}-${Date.now()}`;
  const lang = escapeXml(book.language ?? 'zh-CN');
  const manifestItems = [
    '<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    ...chapterIds.map(
      (id) => `<item id="${escapeXml(id)}" href="chapter-${escapeXml(id)}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
  ].join('\n    ');
  const spineItems = chapterIds.map((id) => `<itemref idref="${escapeXml(id)}"/>`).join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author ?? 'Drifting')}</dc:creator>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;
}

function buildNavXhtml(book: BookInput, chapters: { id: string; title: string }[]): string {
  const lang = escapeXml(book.language ?? 'zh-CN');
  const items = chapters
    .map((c) => `<li><a href="chapter-${escapeXml(c.id)}.xhtml">${escapeXml(c.title)}</a></li>`)
    .join('\n        ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(book.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(book.title)}</h1>
    <ol>
        ${items}
    </ol>
  </nav>
</body>
</html>`;
}

// ───── Writer ─────

export const writeEpub: FormatWriter = async (
  book: BookInput,
  ctx: ExportContext,
): Promise<ExportResult> => {
  const zip = new JSZip();
  const lang = book.language ?? 'zh-CN';

  // The "mimetype" entry must be the FIRST entry in the zip and stored
  // uncompressed. JSZip honors this when we add it before everything else
  // and pass `compression: 'STORE'`.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('OEBPS/styles.css', STYLES_CSS);

  const chapterMeta = book.chapters.map((c) => ({ id: sanitizeFilename(c.id), title: c.title }));

  for (const c of book.chapters) {
    const safeId = sanitizeFilename(c.id);
    const body = renderBlock(c.doc, ctx);
    zip.file(`OEBPS/chapter-${safeId}.xhtml`, buildChapterXhtml(c.title, body, lang));
  }

  zip.file('OEBPS/toc.xhtml', buildNavXhtml(book, chapterMeta));
  zip.file(
    'OEBPS/content.opf',
    buildContentOpf(
      book,
      chapterMeta.map((c) => c.id),
    ),
  );

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    // STORE for mimetype only — other files compress normally (DEFLATE).
    // JSZip respects the per-file compression set above.
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    blob,
    filename: `${sanitizeFilename(book.title)}.epub`,
    mimeType: 'application/epub+zip',
  };
};
