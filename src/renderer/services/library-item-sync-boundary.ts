import type { LibraryItem } from '../domain/library-item';

type LibraryItemRow = Record<string, unknown>;

/**
 * `localPath` identifies a file on this device. It must never cross the sync
 * boundary, even if an older caller (or an outbox row created by an older app
 * version) still includes it.
 */
export function stripLibraryItemDeviceFields(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'localPath')) return payload;
  const serverPayload = { ...payload };
  delete serverPayload.localPath;
  return serverPayload;
}

/** Build the canonical server payload without device-local fields. */
export function libraryItemServerPayload(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    source: item.source,
    uri: item.uri,
    assetId: item.assetId,
    mime: item.mime,
    sizeBytes: item.sizeBytes,
    bodyJson: item.bodyJson,
    notesJson: item.notesJson,
    thumbnailUri: item.thumbnailUri,
    orderKey: item.orderKey,
  };
}

/**
 * Server-visible owner row required before a library asset can be allocated.
 * Device paths (including a file:// URI/thumbnail) remain local until the R2
 * asset is complete; the final library update replaces this placeholder.
 */
export function libraryItemUploadPlaceholderPayload(item: LibraryItem): Record<string, unknown> {
  return {
    ...libraryItemServerPayload(item),
    source: 'local',
    uri: '',
    assetId: null,
    thumbnailUri: null,
  };
}

/**
 * Overlay the only persisted device-local library field on a remote graph.
 *
 * Existing rows keep the path already known by this device. Rows first seen
 * from another device always start with `null`, regardless of what an older
 * server happens to return. Asset ids and object/cache metadata remain remote
 * canonical and are deliberately not overlaid here.
 */
export function overlayLibraryItemDeviceFields(
  remoteRows: LibraryItemRow[],
  localRows: ReadonlyArray<Pick<LibraryItem, 'id' | 'localPath'>>,
): LibraryItemRow[] {
  const localPaths = new Map(localRows.map((row) => [row.id, row.localPath]));

  return remoteRows.map((row) => {
    const id = typeof row.id === 'string' ? row.id : '';
    return {
      ...row,
      localPath: id && localPaths.has(id) ? (localPaths.get(id) ?? null) : null,
    };
  });
}
