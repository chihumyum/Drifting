import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfRuntime } from '../../lib/pdf-runtime-loader';
import { platform } from '../../platform';

interface PdfPreviewDependencies {
  readBytes: typeof platform.material.readBytes;
  loadRuntime: typeof loadPdfRuntime;
}

/** One preview owns one document task. Closing during file/module loading
 * prevents task creation; closing after creation releases that task exactly once. */
export function startPdfPreviewDocument(
  filePath: string,
  callbacks: { onReady: (document: PDFDocumentProxy) => void; onError: (error: unknown) => void },
  dependencies: PdfPreviewDependencies = { readBytes: platform.material.readBytes, loadRuntime: loadPdfRuntime },
) {
  let disposed = false;
  let task: PDFDocumentLoadingTask | null = null;
  let destruction: Promise<void> | null = null;
  const destroy = () => {
    if (task && !destruction) destruction = task.destroy().catch(() => undefined);
    return destruction;
  };
  const completion = (async () => {
    try {
      const result = await dependencies.readBytes(filePath);
      if (disposed) return;
      if (!result.ok) throw new Error(result.error);
      const runtime = await dependencies.loadRuntime();
      if (disposed) return;
      task = runtime.getDocument({ data: new Uint8Array(result.bytes) });
      const document = await task.promise;
      if (!disposed) callbacks.onReady(document);
    } catch (error) {
      await destroy();
      if (!disposed) callbacks.onError(error);
    }
  })();
  return { completion, dispose() { disposed = true; void destroy(); } };
}
