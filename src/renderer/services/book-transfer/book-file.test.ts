import { encode } from 'cborg';
import { describe, expect, it } from 'vitest';

import {
  BOOK_FILE_FORMAT,
  BOOK_FILE_VERSION,
  BookFileError,
  bookFileName,
  decodeBookFile,
  encodeBookFile,
  type BookFileV1,
} from './book-file';

const file: BookFileV1 = {
  format: BOOK_FILE_FORMAT,
  version: BOOK_FILE_VERSION,
  exportedAt: '2026-11-02T12:00:00.000Z',
  title: '傲慢与偏见',
  packageBytes: new Uint8Array([1, 2, 3]),
  commitMarkerBytes: new Uint8Array([4, 5]),
  assets: [{
    assetId: 'asset-1',
    variants: [
      { variant: 'source', ext: 'png', bytes: new Uint8Array([9, 9]) },
      { variant: 'thumbnail', ext: 'jpg', bytes: new Uint8Array([8]) },
    ],
  }],
};

function codeOf(bytes: Uint8Array): string | null {
  try {
    decodeBookFile(bytes);
    return null;
  } catch (error) {
    return error instanceof BookFileError ? error.code : 'other';
  }
}

describe('book file', () => {
  it('round-trips the envelope byte for byte', () => {
    const decoded = decodeBookFile(encodeBookFile(file));
    expect(decoded).toEqual(file);
  });

  it('refuses files that are not books, newer books and malformed asset entries', () => {
    expect(codeOf(new TextEncoder().encode('{"format":"drifting.book"}'))).toBe('not-a-book');
    expect(codeOf(encode({ format: 'drifting.backup', version: 1 }))).toBe('not-a-book');
    expect(codeOf(encode({ ...file, version: BOOK_FILE_VERSION + 1 }))).toBe('newer');
    expect(codeOf(encode({ ...file, packageBytes: new Uint8Array() }))).toBe('not-a-book');
    const badVariant = { ...file, assets: [{ assetId: 'a', variants: [{ variant: 'original', ext: 'png', bytes: new Uint8Array([1]) }] }] };
    expect(codeOf(encode(badVariant))).toBe('not-a-book');
    const badExt = { ...file, assets: [{ assetId: 'a', variants: [{ variant: 'source', ext: '../x', bytes: new Uint8Array([1]) }] }] };
    expect(codeOf(encode(badExt))).toBe('not-a-book');
    const twice = { ...file, assets: [file.assets[0], file.assets[0]] };
    expect(codeOf(encode(twice))).toBe('not-a-book');
  });

  it('names the file after the book', () => {
    expect(bookFileName('傲慢与偏见')).toBe('傲慢与偏见.driftingbook');
    expect(bookFileName('a/b: c?')).toBe('a-b- c-.driftingbook');
    expect(bookFileName('   ')).toBe('未命名.driftingbook');
  });
});
