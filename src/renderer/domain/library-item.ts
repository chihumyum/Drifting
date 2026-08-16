export type LibraryItemKind = 'image' | 'pdf' | 'url' | 'text';

interface LibraryItemBase {
  id: string;
  projectId: string;
  title: string;
  notesJson: string | null;
  orderKey: number;
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

export type LibraryUrlItem = LibraryItemBase & {
  kind: 'url';
  assetId: null;
  externalUrl: string;
  previewImageUrl: string | null;
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
export type LibraryItem = LibraryAssetItem | LibraryUrlItem | LibraryTextItem;

export type LibraryItemPatch = Partial<
  Pick<LibraryItemBase, 'title' | 'notesJson' | 'orderKey' | 'updatedAt'>
> & {
  bodyJson?: string | null;
  previewImageUrl?: string | null;
};

export function isAssetBackedLibraryItem(item: LibraryItem): item is LibraryAssetItem {
  return (item.kind === 'image' || item.kind === 'pdf') && Boolean(item.assetId);
}
