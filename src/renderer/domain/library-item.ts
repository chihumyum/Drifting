/**
 * Material kinds (docs/material-workbench.md). `text` is a note — the author's
 * own writing outside the book. The former `url` kind is retired: migration
 * 0011 turned stored url rows into notes, and url records that still arrive
 * from older builds or checkpoints are converted by `normalizeLegacyUrlRecord`.
 */
export type LibraryItemKind = 'image' | 'pdf' | 'text';

interface LibraryItemBase {
  id: string;
  projectId: string;
  title: string;
  notesJson: string | null;
  /** Versioned origin record (see material-provenance.ts); null for author imports. */
  provenanceJson: string | null;
  orderKey: number;
  /** The material folder holding this item; null = the panel's root. */
  folderId: string | null;
  /** Notes only: whether checklist items become TODOs. Default true. */
  taskTodos: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LibraryAssetItem = LibraryItemBase & {
  kind: 'image' | 'pdf';
  assetId: string;
  externalUrl: null;
  previewImageUrl: null;
  bodyJson: null;
};

export type LibraryTextItem = LibraryItemBase & {
  kind: 'text';
  assetId: null;
  externalUrl: null;
  previewImageUrl: null;
  bodyJson: string | null;
};

/** `kind` is the single payload discriminator; there is no parallel source flag. */
export type LibraryItem = LibraryAssetItem | LibraryTextItem;

export type LibraryItemPatch = Partial<
  Pick<LibraryItemBase, 'title' | 'notesJson' | 'orderKey' | 'folderId' | 'taskTodos' | 'updatedAt'>
> & {
  bodyJson?: string | null;
};

export function isAssetBackedLibraryItem(item: LibraryItem): item is LibraryAssetItem {
  return (item.kind === 'image' || item.kind === 'pdf') && Boolean(item.assetId);
}

/**
 * The note body a retired url material becomes. Must stay byte-identical to
 * the `json_object` expression in drizzle/0011_retire_url_materials.sql so a
 * row migrated locally and the same row converted from sync history agree.
 */
export function legacyUrlNoteBodyJson(url: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', marks: [{ type: 'link', attrs: { href: url } }], text: url }],
      },
    ],
  });
}

/**
 * Converts a retired url record (sync seed or checkpoint row) to a note.
 * An explicit body wins; otherwise the link becomes the body. Other records
 * pass through unchanged.
 */
export function normalizeLegacyUrlRecord<
  T extends { kind?: unknown; externalUrl?: unknown; bodyJson?: unknown },
>(record: T): T {
  if (record.kind !== 'url') return record;
  const url = typeof record.externalUrl === 'string' ? record.externalUrl : '';
  const body =
    typeof record.bodyJson === 'string' && record.bodyJson ? record.bodyJson : legacyUrlNoteBodyJson(url);
  return { ...record, kind: 'text', externalUrl: null, bodyJson: body };
}
