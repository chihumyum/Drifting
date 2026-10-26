import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LibraryItem } from '../../domain/library-item';
import { useDataStore } from '../../store/data-store';
import { useStoredLibraryItemVariant } from './library-item-media';
import {
  ImageMediaStage,
  MediaStageMessage,
  PdfMediaStage,
} from './MaterialMediaStage';
import { useZoomPanSurface } from './use-zoom-pan-surface';

/**
 * Fullscreen lightbox for an image or PDF. Materials themselves open as
 * workspace tabs; this remains for images that are not tabs (the element
 * portrait's「查看大图」) and for a quick look from inside a tab.
 */
export function LibraryItemFullscreenPreview({
  material,
  onClose,
}: {
  material: LibraryItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const isImage = material.kind === 'image';
  const isPdf = material.kind === 'pdf';
  const zoomPan = useZoomPanSurface(surface, isImage || isPdf);
  const imageSource = useStoredLibraryItemVariant(material, 'display', isImage);
  const pdfSource = useStoredLibraryItemVariant(material, 'source', isPdf);
  const asset = useDataStore((state) =>
    material.kind === 'image' || material.kind === 'pdf'
      ? state.projectAssets.find((candidate) => candidate.id === material.assetId) ?? null
      : null,
  );

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  if (!isImage && !isPdf) return null;

  const content = isImage ? (
    imageSource.fileUrl ? (
      <ImageMediaStage
        src={imageSource.fileUrl}
        naturalWidth={asset?.width ?? null}
        naturalHeight={asset?.height ?? null}
        viewport={zoomPan.viewport}
      />
    ) : (
      <MediaStageMessage message={t('memoMaterial.preview.noImage')} />
    )
  ) : pdfSource.filePath ? (
    <PdfMediaStage
      key={pdfSource.filePath}
      filePath={pdfSource.filePath}
      viewport={zoomPan.viewport}
      captureArrowKeys
    />
  ) : (
    <MediaStageMessage message={t('memoMaterial.preview.noPdf')} />
  );

  return createPortal(
    <div className="material-lightbox" onClick={close}>
      <div
        ref={setSurface}
        className="material-stage"
        data-dragging={zoomPan.dragging ? 'true' : undefined}
        data-zoomed={zoomPan.viewport.scale > 1 ? 'true' : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (zoomPan.consumeClickSuppression()) return;
          close();
        }}
        {...zoomPan.pointerHandlers}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}
