import { useEffect, useMemo, useState } from 'react';
import type { LibraryItem } from '../../domain/library-item';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { assetCacheService } from '../../services/asset-cache.service';
import type { AssetVariant } from '../../services/project-asset.service';
import { platform } from '../../platform';

export function basename(path: string | null | undefined): string {
  if (!path) return '';
  const cleaned = path.replace(/^file:\/\//, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** Best-effort display label for the secondary line under a material title.
 *  For local files we show the basename; for URLs we show the hostname. */
export function libraryItemSubtitle(m: LibraryItem): string {
  if (m.kind === 'url') {
    try {
      return new URL(m.uri).hostname.replace(/^www\./, '');
    } catch {
      return m.uri;
    }
  }
  if (m.source === 'r2') return m.mime ?? '';
  return basename(m.localPath ?? m.uri);
}

export function localLibraryItemUrl(m: LibraryItem): string | null {
  const filePath =
    m.localPath ?? (m.uri.startsWith('file://') ? m.uri.slice('file://'.length) : null);
  return filePath ? platform.material.toLocalResourceUrl(filePath) : null;
}

export function libraryItemImageSrc(m: LibraryItem): string | null {
  if (m.kind !== 'image') return null;
  if (/^(https?:|data:|blob:)/.test(m.uri)) return m.uri;
  return localLibraryItemUrl(m);
}

export function libraryItemPdfSrc(m: LibraryItem): string | null {
  if (m.kind !== 'pdf') return null;
  return localLibraryItemUrl(m);
}

export function useCachedLibraryItemVariant(
  material: LibraryItem,
  variant: AssetVariant,
  enabled = true,
): { filePath: string | null; fileUrl: string | null; loading: boolean } {
  const { projectId } = useWorkspaceNavigator();
  const projectAssets = useDataStore((s) => s.projectAssets);
  const asset = useMemo(() => {
    if (material.source !== 'r2' || !material.assetId) return null;
    return projectAssets.find((item) => item.id === material.assetId) ?? null;
  }, [material.assetId, material.source, projectAssets]);
  const cacheKey =
    enabled && material.source === 'r2' && asset?.status === 'ready'
      ? `${projectId}:${asset.id}:${variant}:${asset.updatedAt}`
      : null;
  const [cached, setCached] = useState<{
    key: string;
    filePath: string | null;
    fileUrl: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!cacheKey || !asset) {
      return () => {
        cancelled = true;
      };
    }

    assetCacheService
      .ensureCachedVariant(projectId, asset, variant)
      .then((file) => {
        if (!cancelled) {
          setCached({ key: cacheKey, filePath: file.filePath, fileUrl: file.fileUrl });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[material] failed to cache asset variant:', error);
          setCached({ key: cacheKey, filePath: null, fileUrl: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asset, cacheKey, projectId, variant]);

  if (!cacheKey) return { filePath: null, fileUrl: null, loading: false };
  if (cached?.key === cacheKey) {
    return { filePath: cached.filePath, fileUrl: cached.fileUrl, loading: false };
  }
  return { filePath: null, fileUrl: null, loading: true };
}

export function clampLibraryItemPreviewScale(scale: number): number {
  return Math.min(6, Math.max(0.5, scale));
}

/** Close a transient surface (dialog / dropdown / popover) on Escape, and
 *  blur whatever the user just clicked so the close button doesn't keep
 *  its focus ring after dismissal. */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Drop focus so the trigger button doesn't stay in the hover/active
      // state after the surface closes.
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
