// The legacy pdf.js bundle still supports WebViews that do not implement the
// newest Promise.withResolvers API used by the modern bundle.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

// Vite resolves `?url` to a string in every renderer build. Node/headless
// domain tooling may import the platform graph without ever rendering a PDF;
// its loader does not own that Vite transform, so leave pdf.js unconfigured
// until a real renderer supplies the URL.
if (typeof pdfWorkerUrl === 'string') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface PdfThumbnail {
  bytes: ArrayBuffer;
  dataUrl: string;
  mime: 'image/jpeg';
  sizeBytes: number;
  width: number;
  height: number;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The WebView could not encode the PDF thumbnail.'));
      },
      'image/jpeg',
      quality,
    );
  });
}

/** Render the first PDF page in the WebView so the implementation is identical on every target. */
export async function renderPdfThumbnail(
  source: ArrayBuffer,
  maxLongEdge: number,
  quality: number,
): Promise<PdfThumbnail> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(source.slice(0)) });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const boundedEdge = Math.max(1, Math.min(2048, Math.round(maxLongEdge)));
    const scale = boundedEdge / Math.max(baseViewport.width, baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    await page.render({ canvas, viewport }).promise;
    const normalizedQuality = Math.max(0.01, Math.min(1, quality > 1 ? quality / 100 : quality));
    const [blob, dataUrl] = await Promise.all([
      canvasBlob(canvas, normalizedQuality),
      Promise.resolve(canvas.toDataURL('image/jpeg', normalizedQuality)),
    ]);
    const bytes = await blob.arrayBuffer();
    canvas.width = 1;
    canvas.height = 1;
    return {
      bytes,
      dataUrl,
      mime: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
    };
  } finally {
    await document.destroy();
  }
}

export function hasPdfSignature(bytes: ArrayBuffer): boolean {
  const signature = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength));
  return (
    signature.length === 5 &&
    signature[0] === 0x25 &&
    signature[1] === 0x50 &&
    signature[2] === 0x44 &&
    signature[3] === 0x46 &&
    signature[4] === 0x2d
  );
}
