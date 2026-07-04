export type LibraryItemKind = 'image' | 'pdf' | 'url' | 'text';

export type LibraryItemSource = 'local' | 'url' | 'r2';

export interface LibraryItem {
  id: string;
  projectId: string;
  title: string;
  kind: LibraryItemKind;
  source: LibraryItemSource;
  /** http(s) URL for `source === 'url'`; file:// for old local items; asset://id for R2. */
  uri: string;
  /** Absolute original pick path for old local items; null for R2 canonical items. */
  localPath: string | null;
  /** Cloud asset for R2-backed image/pdf materials. Local files are per-device cache. */
  assetId: string | null;
  mime: string | null;
  sizeBytes: number | null;
  /** Plain-text body when `kind === 'text'`; otherwise null. */
  bodyJson: string | null;
  /** Free-form author annotations attached to the item. */
  notesJson: string | null;
  thumbnailUri: string | null;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}
