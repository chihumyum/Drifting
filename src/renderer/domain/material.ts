export type MaterialKind = 'image' | 'pdf' | 'url' | 'text';

export type MaterialSource = 'local' | 'url';

export interface Material {
  id: string;
  projectId: string;
  title: string;
  kind: MaterialKind;
  source: MaterialSource;
  /** http(s) URL for `source === 'url'`; file:// path for `source === 'local'`. */
  uri: string;
  /** Absolute on-disk path when `source === 'local'`; null otherwise. */
  localPath: string | null;
  mime: string | null;
  sizeBytes: number | null;
  /** Plain-text body when `kind === 'text'`; otherwise null. */
  bodyJson: string | null;
  /** Free-form author annotations attached to the material. */
  notesJson: string | null;
  thumbnailUri: string | null;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}
