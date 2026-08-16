import { useEffect, useMemo, useState } from 'react';
import type { LibraryItem } from '../../domain/library-item';
import type { ProjectAssetVariant } from '../../domain/project-asset';
import { assetStoreService } from '../../services/asset-store.service';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';

export function libraryItemSubtitle(item: LibraryItem): string {
  if (item.kind === 'url') {
    try {
      return new URL(item.externalUrl).hostname.replace(/^www\./, '');
    } catch {
      return item.externalUrl;
    }
  }
  return item.kind === 'pdf' ? 'PDF' : '';
}

export function useStoredLibraryItemVariant(
  material: LibraryItem,
  variant: ProjectAssetVariant,
  enabled = true,
): { filePath: string | null; fileUrl: string | null; loading: boolean } {
  const { projectId } = useWorkspaceNavigator();
  const projectAssets = useDataStore((state) => state.projectAssets);
  const asset = useMemo(() => {
    if (material.kind !== 'image' && material.kind !== 'pdf') return null;
    return projectAssets.find((item) => item.id === material.assetId) ?? null;
  }, [material, projectAssets]);
  const storeKey = enabled && asset ? `${projectId}:${asset.id}:${variant}:${asset.createdAt}` : null;
  const [stored, setStored] = useState<{
    key: string;
    filePath: string | null;
    fileUrl: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!storeKey || !asset) return () => undefined;

    assetStoreService
      .requireVariant(projectId, asset, variant)
      .then((file) => {
        if (!cancelled) {
          setStored({ key: storeKey, filePath: file.filePath, fileUrl: file.fileUrl });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[material] local asset variant is unavailable:', error);
          setStored({ key: storeKey, filePath: null, fileUrl: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asset, projectId, storeKey, variant]);

  if (!storeKey) return { filePath: null, fileUrl: null, loading: false };
  if (stored?.key === storeKey) {
    return { filePath: stored.filePath, fileUrl: stored.fileUrl, loading: false };
  }
  return { filePath: null, fileUrl: null, loading: true };
}

export function clampLibraryItemPreviewScale(scale: number): number {
  return Math.min(6, Math.max(0.5, scale));
}

export function useEscapeToClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
      ) {
        document.activeElement.blur();
      }
      onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [active, onClose]);
}
