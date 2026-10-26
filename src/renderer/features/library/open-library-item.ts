import type { LibraryItem } from '../../domain/library-item';
import { platform } from '../../platform';
import { assetStoreService } from '../../services/asset-store.service';
import { useDataStore } from '../../store/data-store';

/** Hands an image/PDF material's source file to the OS default application. */
export async function openLibraryItemInSystem(
  projectId: string,
  item: LibraryItem,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (item.kind !== 'image' && item.kind !== 'pdf') return { ok: true };
  const asset = useDataStore.getState().projectAssets.find((candidate) => candidate.id === item.assetId);
  if (!asset) return { ok: false, error: 'missing asset metadata' };
  let path: string;
  try {
    path = (await assetStoreService.requireVariant(projectId, asset, 'source')).filePath;
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  return toResult(await platform.material.openLocal(path));
}

function toResult(result: { ok: boolean; error?: string }): { ok: true } | { ok: false; error: string } {
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'unknown error' };
}
