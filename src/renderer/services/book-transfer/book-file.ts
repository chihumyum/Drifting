// The `.driftingbook` file one book travels in between libraries
// (docs/book-transfer.md): an ordinary sync snapshot package and its commit
// marker, plus every stored variant of the book's assets. The package and the
// source bytes carry their own hashes; the file adds only a versioned envelope.
import { decode, encode } from 'cborg';

import type { ProjectAssetVariant } from '../../domain/project-asset';
import { readableFileStem } from '../export/readable-file-stem';

export const BOOK_FILE_FORMAT = 'drifting.book' as const;
export const BOOK_FILE_VERSION = 1 as const;
export const BOOK_FILE_EXTENSION = 'driftingbook';
/** Matches the native open/save limit (src-tauri/src/book_transfer.rs). */
export const BOOK_FILE_MAX_BYTES = 1024 * 1024 * 1024;

const VARIANTS: readonly ProjectAssetVariant[] = ['source', 'display', 'thumbnail'];

export interface BookFileAssetVariantV1 {
  readonly variant: ProjectAssetVariant;
  readonly ext: string;
  readonly bytes: Uint8Array;
}

export interface BookFileAssetV1 {
  readonly assetId: string;
  readonly variants: readonly BookFileAssetVariantV1[];
}

export interface BookFileV1 {
  readonly format: typeof BOOK_FILE_FORMAT;
  readonly version: typeof BOOK_FILE_VERSION;
  readonly exportedAt: string;
  readonly title: string;
  readonly packageBytes: Uint8Array;
  readonly commitMarkerBytes: Uint8Array;
  readonly assets: readonly BookFileAssetV1[];
}

export type BookFileErrorCode = 'not-a-book' | 'newer' | 'too-large';

export class BookFileError extends Error {
  constructor(
    readonly code: BookFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BookFileError';
  }
}

export function encodeBookFile(file: BookFileV1): Uint8Array {
  const bytes = encode(file);
  if (bytes.byteLength > BOOK_FILE_MAX_BYTES) {
    throw new BookFileError('too-large', 'The book is larger than a book file can hold');
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? (value as Record<string, unknown>)
    : null;
}

function bytesField(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new BookFileError('not-a-book', `${label} is missing`);
  }
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new BookFileError('not-a-book', `${label} is missing`);
  return value;
}

function parseVariant(value: unknown): BookFileAssetVariantV1 {
  const entry = record(value);
  const variant = entry?.variant;
  const ext = entry?.ext;
  if (
    !entry ||
    !VARIANTS.includes(variant as ProjectAssetVariant) ||
    typeof ext !== 'string' ||
    !/^[a-z0-9]{1,8}$/u.test(ext)
  ) {
    throw new BookFileError('not-a-book', 'An asset variant is malformed');
  }
  return { variant: variant as ProjectAssetVariant, ext, bytes: bytesField(entry.bytes, 'Asset bytes') };
}

function parseAsset(value: unknown): BookFileAssetV1 {
  const entry = record(value);
  if (!entry || !Array.isArray(entry.variants)) {
    throw new BookFileError('not-a-book', 'An asset entry is malformed');
  }
  const variants = entry.variants.map(parseVariant);
  if (new Set(variants.map((variant) => variant.variant)).size !== variants.length) {
    throw new BookFileError('not-a-book', 'An asset repeats a variant');
  }
  return { assetId: stringField(entry.assetId, 'Asset id'), variants };
}

/** Decode the envelope only; the package inside is validated on import. */
export function decodeBookFile(bytes: Uint8Array): BookFileV1 {
  if (bytes.byteLength > BOOK_FILE_MAX_BYTES) {
    throw new BookFileError('too-large', 'The file is larger than a book file can be');
  }
  let value: unknown;
  try {
    value = decode(bytes);
  } catch {
    throw new BookFileError('not-a-book', 'The file is not a Drifting book');
  }
  const file = record(value);
  if (!file || file.format !== BOOK_FILE_FORMAT) {
    throw new BookFileError('not-a-book', 'The file is not a Drifting book');
  }
  if (typeof file.version !== 'number' || !Number.isSafeInteger(file.version) || file.version < 1) {
    throw new BookFileError('not-a-book', 'The book file has no version');
  }
  if (file.version > BOOK_FILE_VERSION) {
    throw new BookFileError('newer', 'The book was exported by a newer Drifting');
  }
  if (!Array.isArray(file.assets)) throw new BookFileError('not-a-book', 'The asset list is missing');
  const assets = file.assets.map(parseAsset);
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new BookFileError('not-a-book', 'The book file lists an asset twice');
  }
  return {
    format: BOOK_FILE_FORMAT,
    version: BOOK_FILE_VERSION,
    exportedAt: stringField(file.exportedAt, 'Export time'),
    title: stringField(file.title, 'Title'),
    packageBytes: bytesField(file.packageBytes, 'Snapshot package'),
    commitMarkerBytes: bytesField(file.commitMarkerBytes, 'Snapshot commit marker'),
    assets,
  };
}

/** `<title>.driftingbook`, named as the book's Markdown folder is. */
export function bookFileName(title: string): string {
  return `${readableFileStem(title)}.${BOOK_FILE_EXTENSION}`;
}
