// Imported only when a PDF operation needs the engine. Keep the legacy build
// for WebViews without Promise.withResolvers and the worker in local assets.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

// The Vite renderer owns the worker URL transform; headless domain tooling
// does not configure a worker from an unresolved module value.
if (typeof pdfWorkerUrl === 'string') pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { pdfjsLib };
