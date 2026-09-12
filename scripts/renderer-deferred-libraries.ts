import { renderPdfThumbnail, hasPdfSignature } from '../src/renderer/lib/pdf-thumbnail';
import { buildRelationalMarkdownArchive } from '../src/renderer/services/export/relational-markdown.service';

/** A redistributable synthetic PDF: one red rectangle, no fonts or user data. */
function syntheticPdf() {
  const stream = '1 0 0 rg\n0 0 240 120 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}

const fixture = syntheticPdf();
const api = {
  async fixture() {
    const hash = await crypto.subtle.digest('SHA-256', fixture);
    return { pdfSha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), pdfBytes: fixture.byteLength, provenance: 'synthetic red rectangle; no external content' };
  },
  async invalidPdf() {
    try {
      await renderPdfThumbnail(new TextEncoder().encode('%PDF-1.4\nSynthetic invalid document').buffer, 120, 80);
      return { rejected: false };
    } catch (error) { return { rejected: true, name: error instanceof Error ? error.name : String(error) }; }
  },
  async pdf() {
    const start = performance.now();
    const result = await renderPdfThumbnail(fixture, 120, 80);
    const image = new Image(); image.src = result.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixel = Array.from(context.getImageData(60, 30, 1, 1).data);
    return { elapsedMs: performance.now() - start, width: result.width, height: result.height, mime: result.mime, sizeBytes: result.sizeBytes, pixel, sourceBytes: fixture.byteLength, sourceIntact: hasPdfSignature(fixture) };
  },
  async archive() {
    const start = performance.now();
    const result = await buildRelationalMarkdownArchive({ books: [], proseByDocId: new Map() }, new Date('2026-09-12T00:00:00.000Z'));
    return { elapsedMs: performance.now() - start, filename: result.filename, documents: result.documentCount, bytes: Array.from(result.bytes) };
  },
};

(window as typeof window & { __DEFERRED_LIBRARIES__?: typeof api }).__DEFERRED_LIBRARIES__ = api;
