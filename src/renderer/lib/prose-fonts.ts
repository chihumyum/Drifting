const DATABASE_NAME = 'drifting-local-assets';
const DATABASE_VERSION = 1;
const STORE_NAME = 'prose-fonts';
const ACTIVE_FONT_ID = 'active';

export const IMPORTED_PROSE_FONT_FAMILY = 'Drifting Imported Prose';
export const IMPORTED_PROSE_FONT_ACCEPT =
  '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';
export const MAX_IMPORTED_PROSE_FONT_BYTES = 64 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);

interface ImportedProseFontRecord {
  id: typeof ACTIVE_FONT_ID;
  fileName: string;
  mimeType: string;
  byteLength: number;
  updatedAt: number;
  data: Blob;
}

export interface ImportedProseFontMetadata {
  fileName: string;
  mimeType: string;
  byteLength: number;
  updatedAt: number;
}

export type ProseFontImportErrorCode =
  | 'empty'
  | 'unsupported-format'
  | 'too-large'
  | 'invalid-font'
  | 'storage-unavailable';

export class ProseFontImportError extends Error {
  constructor(
    readonly code: ProseFontImportErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProseFontImportError';
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;
let activeFontFace: FontFace | null = null;
let fontFaceGeneration = 0;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new ProseFontImportError(
        'storage-unavailable',
        'IndexedDB is unavailable in this runtime.',
      ),
    );
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(
        new ProseFontImportError(
          'storage-unavailable',
          'Unable to open local font storage.',
          request.error,
        ),
      );
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(
        new ProseFontImportError(
          'storage-unavailable',
          'Local font storage is blocked by another app window.',
        ),
      );
    };
  });
  return databasePromise;
}

async function runRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () =>
      reject(
        new ProseFontImportError(
          'storage-unavailable',
          'Unable to access local font storage.',
          request.error,
        ),
      );
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () =>
      reject(
        new ProseFontImportError(
          'storage-unavailable',
          'The local font storage transaction was aborted.',
          transaction.error,
        ),
      );
  });
}

function metadataOf(record: ImportedProseFontRecord): ImportedProseFontMetadata {
  return {
    fileName: record.fileName,
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    updatedAt: record.updatedAt,
  };
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function validateImportedProseFontFile(file: Pick<File, 'name' | 'size'>): void {
  if (file.size <= 0) {
    throw new ProseFontImportError('empty', 'The selected font file is empty.');
  }
  if (!SUPPORTED_EXTENSIONS.has(extensionOf(file.name))) {
    throw new ProseFontImportError(
      'unsupported-format',
      'Only TTF, OTF, WOFF, and WOFF2 font files are supported.',
    );
  }
  if (file.size > MAX_IMPORTED_PROSE_FONT_BYTES) {
    throw new ProseFontImportError(
      'too-large',
      'The selected font file exceeds the 64 MB limit.',
    );
  }
}

async function loadFontFace(bytes: ArrayBuffer): Promise<FontFace> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new ProseFontImportError(
      'invalid-font',
      'Custom fonts are unavailable in this runtime.',
    );
  }

  try {
    // V1 accepts one Regular or variable font. Advertising the usable weight
    // range lets a variable file respond to prose/headline weights; a static
    // Regular file remains the single face and is intentionally not combined
    // with separate bold or italic files.
    const face = new FontFace(IMPORTED_PROSE_FONT_FAMILY, bytes, {
      style: 'normal',
      weight: '100 900',
    });
    await face.load();
    return face;
  } catch (error) {
    throw new ProseFontImportError(
      'invalid-font',
      'The selected file could not be decoded as a font.',
      error,
    );
  }
}

function installFontFace(face: FontFace): void {
  if (activeFontFace) document.fonts.delete(activeFontFace);
  document.fonts.add(face);
  activeFontFace = face;
}

async function getRecord(): Promise<ImportedProseFontRecord | null> {
  const record = await runRequest<ImportedProseFontRecord | undefined>('readonly', (store) =>
    store.get(ACTIVE_FONT_ID),
  );
  return record ?? null;
}

export async function getImportedProseFontMetadata(): Promise<ImportedProseFontMetadata | null> {
  const record = await getRecord();
  return record ? metadataOf(record) : null;
}

export async function importProseFont(file: File): Promise<ImportedProseFontMetadata> {
  validateImportedProseFontFile(file);

  const generation = ++fontFaceGeneration;
  const bytes = await file.arrayBuffer();
  const face = await loadFontFace(bytes);
  const record: ImportedProseFontRecord = {
    id: ACTIVE_FONT_ID,
    fileName: file.name,
    mimeType: file.type || `font/${extensionOf(file.name)}`,
    byteLength: file.size,
    updatedAt: Date.now(),
    data: new Blob([bytes], { type: file.type || 'application/octet-stream' }),
  };

  await runRequest<IDBValidKey>('readwrite', (store) => store.put(record));
  if (generation === fontFaceGeneration) installFontFace(face);
  return metadataOf(record);
}

export async function ensureImportedProseFontLoaded(): Promise<ImportedProseFontMetadata | null> {
  const record = await getRecord();
  if (!record) return null;
  if (activeFontFace?.status === 'loaded') return metadataOf(record);

  const generation = ++fontFaceGeneration;
  const face = await loadFontFace(await record.data.arrayBuffer());
  if (generation === fontFaceGeneration) installFontFace(face);
  return metadataOf(record);
}

export async function removeImportedProseFont(): Promise<void> {
  fontFaceGeneration += 1;
  await runRequest<undefined>('readwrite', (store) => store.delete(ACTIVE_FONT_ID));
  if (activeFontFace && typeof document !== 'undefined' && document.fonts) {
    document.fonts.delete(activeFontFace);
  }
  activeFontFace = null;
}
