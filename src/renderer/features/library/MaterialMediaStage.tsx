import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { startPdfPreviewDocument } from './pdf-preview-document';
import type { MediaViewport } from './use-zoom-pan-surface';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { getPlatformRuntime } from '../../platform/runtime';

// Shared media surfaces for image and PDF materials: the material tab and the
// fullscreen lightbox both render through these, so zoom/pan, PDF paging and
// the overlay coordinate space (used by region comments) behave identically.

function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
  T | null,
] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size, node];
}

function transformStyle(viewport: MediaViewport): React.CSSProperties {
  return {
    transform: `translate3d(${viewport.panX}px, ${viewport.panY}px, 0) scale(${viewport.scale})`,
    transformOrigin: 'center center',
    // Trackpad pinch/pan arrives as a dense wheel stream. A transition here
    // restarts on every delta and makes the media trail the gesture, which
    // reads as shaking in WKWebView.
    transition: 'none',
    willChange: 'transform',
    backfaceVisibility: 'hidden',
  };
}

/** The fitted box a media element occupies inside its surface. */
export interface MediaBox {
  width: number;
  height: number;
  /** PDF page number (1-based); null for images. */
  page: number | null;
}

interface StageProps {
  viewport: MediaViewport;
  /** Optional layer drawn in the media's own coordinate box (0..width/height). */
  overlay?: (box: MediaBox) => ReactNode;
}

export function MediaStageMessage({ message }: { message: string }) {
  return <div className="material-stage__message">{message}</div>;
}

/** An image fitted to its surface (never upscaled past the display variant). */
export function ImageMediaStage({
  src,
  naturalWidth,
  naturalHeight,
  viewport,
  overlay,
}: StageProps & { src: string; naturalWidth: number | null; naturalHeight: number | null }) {
  const [setSurface, surfaceSize] = useElementSize<HTMLDivElement>();
  const [loadedSize, setLoadedSize] = useState<{ width: number; height: number } | null>(null);
  const width = loadedSize?.width ?? naturalWidth ?? 0;
  const height = loadedSize?.height ?? naturalHeight ?? 0;
  const fit =
    width > 0 && height > 0 && surfaceSize.width > 0 && surfaceSize.height > 0
      ? Math.min(1, surfaceSize.width / width, surfaceSize.height / height)
      : 0;
  const box = { width: Math.floor(width * fit), height: Math.floor(height * fit), page: null };

  return (
    <div ref={setSurface} className="material-stage__fit">
      <div
        className="material-stage__media"
        style={{
          width: box.width || undefined,
          height: box.height || undefined,
          visibility: fit > 0 ? 'visible' : 'hidden',
          ...transformStyle(viewport),
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            setLoadedSize({ width: image.naturalWidth, height: image.naturalHeight });
          }}
          style={{ width: '100%', height: '100%', display: 'block', userSelect: 'none' }}
        />
        {fit > 0 && overlay?.(box)}
      </div>
    </div>
  );
}

function isPdfRenderCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

/**
 * One PDF page fitted to its surface. Paging is controlled when `page` is
 * passed (region comments jump to a page) and internal otherwise.
 */
export function PdfMediaStage({
  filePath,
  viewport,
  overlay,
  page: controlledPage,
  onPageChange,
  captureArrowKeys = false,
}: StageProps & {
  filePath: string;
  page?: number;
  onPageChange?: (page: number) => void;
  /** Window-level ←/→ paging, for the modal lightbox only. */
  captureArrowKeys?: boolean;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [setSurface, surfaceSize, surfaceNode] = useElementSize<HTMLDivElement>();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [internalPage, setInternalPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [cssSize, setCssSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<'openPdfFailed' | 'renderPdfFailed' | null>(null);
  const pageNumber = Math.min(Math.max(1, controlledPage ?? internalPage), Math.max(1, pageCount));

  const setPage = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(1, next), Math.max(1, pageCount));
      if (onPageChange) onPageChange(clamped);
      else setInternalPage(clamped);
    },
    [onPageChange, pageCount],
  );

  // Load via the native platform command rather than handing pdf.js a
  // `file://` URL — WebViews block `fetch('file://…')` from non-file origins
  // (the Vite dev server) regardless of `webSecurity`.
  useEffect(() => {
    const session = startPdfPreviewDocument(filePath, {
      onReady(nextDocument) {
        setPdfDocument(nextDocument);
        setPageCount(nextDocument.numPages);
      },
      onError(loadError) {
        console.error('[pdf preview] document load failed:', loadError);
        setError('openPdfFailed');
      },
    });
    return session.dispose;
  }, [filePath]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const canvas = canvasRef.current;
    pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return undefined;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(160, surfaceSize.width - 32);
        const availableHeight = Math.max(160, surfaceSize.height - (pageCount > 1 ? 72 : 32));
        const cssScale = Math.max(
          0.18,
          Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height, 1.8),
        );
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const cssViewport = page.getViewport({ scale: cssScale });
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        const nextCss = { width: Math.floor(cssViewport.width), height: Math.floor(cssViewport.height) };
        setCssSize((prev) =>
          prev && prev.width === nextCss.width && prev.height === nextCss.height ? prev : nextCss,
        );
        renderTask = page.render({ canvas, viewport: renderViewport });
        return renderTask.promise;
      })
      .catch((renderError: unknown) => {
        if (cancelled || isPdfRenderCancel(renderError)) return;
        console.error('[pdf preview] render failed:', renderError);
        setError('renderPdfFailed');
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber, pageCount, surfaceSize.height, surfaceSize.width]);

  // ←/→ flip pages: window-level in the modal lightbox, focus-scoped in a tab
  // so arrow keys elsewhere in the workspace keep their meaning.
  useEffect(() => {
    if (!pdfDocument || pageCount <= 1) return;
    const target: HTMLElement | Window | null = captureArrowKeys ? window : surfaceNode;
    if (!target) return;
    const onKey = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight') return;
      const origin = keyEvent.target as HTMLElement | null;
      if (origin?.closest('input, textarea, [contenteditable="true"]')) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setPage(pageNumber + (keyEvent.key === 'ArrowLeft' ? -1 : 1));
    };
    target.addEventListener('keydown', onKey, captureArrowKeys);
    return () => target.removeEventListener('keydown', onKey, captureArrowKeys);
  }, [captureArrowKeys, pageCount, pageNumber, pdfDocument, setPage, surfaceNode]);

  return (
    <div ref={setSurface} className="material-stage__fit" tabIndex={captureArrowKeys ? undefined : 0}>
      {error ? (
        <MediaStageMessage message={t(`memoMaterial.preview.${error}`)} />
      ) : !pdfDocument ? (
        <MediaStageMessage message={t('memoMaterial.preview.loadingPdf')} />
      ) : (
        <div
          className="material-stage__media material-stage__media--pdf"
          style={{
            width: cssSize?.width,
            height: cssSize?.height,
            ...transformStyle(viewport),
          }}
        >
          <canvas
            ref={canvasRef}
            onClick={(event) => event.stopPropagation()}
            style={{ width: '100%', height: '100%', display: 'block', userSelect: 'none' }}
          />
          {cssSize && overlay?.({ width: cssSize.width, height: cssSize.height, page: pageNumber })}
        </div>
      )}

      {pageCount > 1 && !getPlatformRuntime().isMobileShell && (
        // Desktop: a glass pill of two round glass buttons and the page count.
        <div
          className="material-stage__pager-bar"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="editor-bar glass glass--rest" role="toolbar" aria-label={t('memoMaterial.preview.pages')}>
            <button
              type="button"
              className="editor-bar__icon glass glass--round"
              title={t('memoMaterial.preview.previousPage')}
              aria-label={t('memoMaterial.preview.previousPage')}
              onClick={() => setPage(pageNumber - 1)}
              disabled={pageNumber <= 1}
            >
              <BrushIcon name="chevron-left" />
            </button>
            <span className="material-stage__page">
              {pageNumber} / {pageCount}
            </span>
            <button
              type="button"
              className="editor-bar__icon glass glass--round"
              title={t('memoMaterial.preview.nextPage')}
              aria-label={t('memoMaterial.preview.nextPage')}
              onClick={() => setPage(pageNumber + 1)}
              disabled={pageNumber >= pageCount}
            >
              <BrushIcon name="chevron-right" />
            </button>
          </div>
        </div>
      )}
      {pageCount > 1 && getPlatformRuntime().isMobileShell && (
        <div
          className="material-stage__pager"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => setPage(pageNumber - 1)} disabled={pageNumber <= 1}>
            {t('memoMaterial.preview.previousPage')}
          </button>
          <span>
            {pageNumber} / {pageCount}
          </span>
          <button type="button" onClick={() => setPage(pageNumber + 1)} disabled={pageNumber >= pageCount}>
            {t('memoMaterial.preview.nextPage')}
          </button>
        </div>
      )}
    </div>
  );
}
