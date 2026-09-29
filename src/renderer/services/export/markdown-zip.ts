import { isTauri } from '@tauri-apps/api/core';
import { platform } from '../../platform';

export interface MarkdownZipEntry { path: string; text: string }

/** Browser/headless fallback. Encode the whole string before JSZip chunks it:
 * its string stream can otherwise split an emoji's surrogate pair. */
export async function createPortableMarkdownZip(entries: MarkdownZipEntry[]): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const encoder = new TextEncoder();
  for (const entry of entries) zip.file(entry.path, encoder.encode(entry.text));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function createMarkdownZip(entries: MarkdownZipEntry[]): Promise<Uint8Array> {
  return isTauri() ? platform.archive.createTextZip(entries) : createPortableMarkdownZip(entries);
}
