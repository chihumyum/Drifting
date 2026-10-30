import type { PDFDocumentProxy } from 'pdfjs-dist';

import type { LibraryAssetItem } from '../../domain/library-item';
import type { ProjectAsset, ProjectAssetVariant } from '../../domain/project-asset';
import { platform } from '../../platform';
import { assetStoreService } from '../../services/asset-store.service';
import { useDataStore } from '../../store/data-store';
import { loadPdfRuntime } from '../pdf-runtime-loader';
import type { AgentModelImageInput } from './runtime/types';

/**
 * What the Agent can take from an image or PDF material: a PDF's text layer,
 * read locally page by page, and pictures (an image's display variant or
 * rendered PDF pages) for a vision request. Bytes never enter the durable
 * conversation; only text derived from them does.
 */
export interface PageRange {
  from: number;
  to: number;
}

/** "3" or "2-5" (1-based, inclusive); undefined means "from the start". */
export function parsePageRange(value: unknown, pageCount: number): PageRange | null {
  if (value === undefined || value === null || value === '') return null;
  const match = /^\s*(\d+)\s*(?:[-–~至到]\s*(\d+))?\s*$/u.exec(String(value));
  if (!match) throw new Error('pages 写成 "3" 或 "2-5" 这样的页码');
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from) throw new Error('页码从 1 开始，结束页不能早于起始页');
  if (from > pageCount) throw new Error(`这份 PDF 只有 ${pageCount} 页`);
  return { from, to: Math.min(to, pageCount) };
}

function assetFor(item: LibraryAssetItem): ProjectAsset {
  const asset = useDataStore.getState().projectAssets.find((candidate) => candidate.id === item.assetId);
  if (!asset) throw new Error(`素材「${item.title}」的文件不在本机`);
  return asset;
}

async function assetBytes(projectId: string, item: LibraryAssetItem, variant: ProjectAssetVariant): Promise<Uint8Array> {
  const file = await assetStoreService.requireVariant(projectId, assetFor(item), variant);
  const result = await platform.material.readBytes(file.filePath);
  if (!result.ok) throw new Error(result.error);
  return new Uint8Array(result.bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function withPdf<T>(projectId: string, item: LibraryAssetItem, work: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const runtime = await loadPdfRuntime();
  const task = runtime.getDocument({ data: await assetBytes(projectId, item, 'source') });
  try {
    return await work(await task.promise);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** Text layers of a PDF, cached per asset: assets are immutable. */
const pdfTextCache = new Map<string, string[]>();
const MAX_CACHED_PDFS = 8;

export async function pdfPageTexts(projectId: string, item: LibraryAssetItem): Promise<string[]> {
  const cached = pdfTextCache.get(item.assetId);
  if (cached) return cached;
  const pages = await withPdf(projectId, item, async (pdf) => {
    const texts: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      texts.push(
        content.items
          .map((entry) => ('str' in entry ? entry.str + (entry.hasEOL ? '\n' : '') : ''))
          .join('')
          .replace(/[ \t]+\n/gu, '\n')
          .replace(/\n{3,}/gu, '\n\n')
          .trim(),
      );
      page.cleanup();
    }
    return texts;
  });
  pdfTextCache.set(item.assetId, pages);
  while (pdfTextCache.size > MAX_CACHED_PDFS) pdfTextCache.delete(pdfTextCache.keys().next().value!);
  return pages;
}

export interface PdfTextExcerpt {
  pageCount: number;
  pages: string;
  text: string;
  /** The next unread page when the budget stopped early. */
  nextPage?: number;
  /** Pages in range that have no text layer (likely scans). */
  pagesWithoutText?: number[];
}

/** Page-labelled text for a range, stopping at `budget` characters. */
export function excerptPdfText(pages: readonly string[], range: PageRange | null, budget: number): PdfTextExcerpt {
  const from = range?.from ?? 1;
  const to = range?.to ?? pages.length;
  const parts: string[] = [];
  const blank: number[] = [];
  let used = 0;
  let last = from - 1;
  for (let number = from; number <= to; number += 1) {
    const text = pages[number - 1] ?? '';
    const part = `［第 ${number} 页］\n${text || '（这一页没有文字层）'}`;
    if (used > 0 && used + part.length > budget) break;
    if (!text) blank.push(number);
    parts.push(part);
    used += part.length + 2;
    last = number;
  }
  return {
    pageCount: pages.length,
    pages: from === last ? String(from) : `${from}-${last}`,
    text: parts.join('\n\n'),
    ...(last < to ? { nextPage: last + 1 } : {}),
    ...(blank.length > 0 ? { pagesWithoutText: blank } : {}),
  };
}

/** Pictures of a material for a vision request: an image, or up to `maxPages` PDF pages. */
export async function materialImages(
  projectId: string,
  item: LibraryAssetItem,
  range: PageRange | null,
  maxPages: number,
): Promise<{ images: AgentModelImageInput[]; pages?: string; pageCount?: number }> {
  if (item.kind === 'image') {
    return { images: [{ mediaType: 'image/jpeg', data: bytesToBase64(await assetBytes(projectId, item, 'display')) }] };
  }
  return withPdf(projectId, item, async (pdf) => {
    const from = range?.from ?? 1;
    const to = Math.min(range?.to ?? from, from + maxPages - 1, pdf.numPages);
    const images: AgentModelImageInput[] = [];
    for (let number = from; number <= to; number += 1) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      // About 1600 px on the long side: legible text, a modest request.
      const viewport = page.getViewport({ scale: Math.min(3, 1600 / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // The print intent renders without requestAnimationFrame, so a page
      // still renders while the window is hidden and the Agent works on.
      await page.render({ canvas, viewport, intent: 'print' }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      images.push({ mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      page.cleanup();
    }
    return { images, pages: from === to ? String(from) : `${from}-${to}`, pageCount: pdf.numPages };
  });
}
