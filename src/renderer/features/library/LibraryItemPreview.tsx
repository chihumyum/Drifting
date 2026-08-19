import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { LibraryItem, LibraryItemPatch } from '../../domain/library-item';
import { createPlainCommentDoc, extractTextFromCommentBody } from '../../domain/comment';
import { Button } from '../../components/ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { platform } from '../../platform';
import {
  clampLibraryItemPreviewScale,
  useStoredLibraryItemVariant,
} from './library-item-media';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function TextSnippetPopover({
  material,
  onClose,
  onExpand,
  onUpdate,
}: {
  material: LibraryItem;
  onClose: () => void;
  onExpand: () => void;
  onUpdate: (updates: LibraryItemPatch) => void;
}) {
  const { t } = useTranslation();
  const currentBody = extractTextFromCommentBody(material.bodyJson);
  const [draft, setDraft] = useState(currentBody);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const persistIfChanged = useCallback(() => {
    const next = draftRef.current;
    if (next !== currentBody) {
      onUpdate({ bodyJson: next ? createPlainCommentDoc(next) : null });
    }
  }, [currentBody, onUpdate]);

  const close = useCallback(() => {
    persistIfChanged();
    onClose();
  }, [persistIfChanged, onClose]);

  const expand = useCallback(() => {
    persistIfChanged();
    onExpand();
  }, [persistIfChanged, onExpand]);

  return (
    <ModalRoot onClose={close} ariaLabel={material.title || t('common.untitled')}>
      <ModalCard width="min(440px, 92vw)">
        <ModalHeader
          kicker={t('memoMaterial.kind.text')}
          title={material.title || t('common.untitled')}
          onClose={close}
          closeLabel={t('memoMaterial.preview.closeEsc')}
        />
        <ModalBody>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('memoMaterial.card.snippetPlaceholder')}
            style={{
              width: '100%',
              height: '100%',
              minHeight: 180,
              resize: 'none',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              padding: '8px 10px',
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-1))',
              fontFamily: 'var(--font-sans)',
              fontSize: 13.5,
              lineHeight: 1.55,
              outline: 'none',
              whiteSpace: 'pre-wrap',
            }}
          />
        </ModalBody>
        <ModalActions>
          <Button
            onClick={expand}
            title={t('memoMaterial.preview.expandFullscreenTitle')}
            variant="default"
            size="sm"
          >
            {t('memoMaterial.preview.fullscreen')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-screen material preview

type LibraryItemPreviewViewport = {
  scale: number;
  panX: number;
  panY: number;
};

function zoomLibraryItemPreviewAt(
  prev: LibraryItemPreviewViewport,
  scale: number,
  anchorFromCenterX: number,
  anchorFromCenterY: number,
): LibraryItemPreviewViewport {
  if (scale === prev.scale) return prev;
  // 缩到适配尺寸以内（≤1）时图片小于视口，无需平移：保留缩放值、居中复位。
  if (scale <= 1) return { scale, panX: 0, panY: 0 };

  const ratio = scale / prev.scale;
  return {
    scale,
    panX: ratio * prev.panX + (1 - ratio) * anchorFromCenterX,
    panY: ratio * prev.panY + (1 - ratio) * anchorFromCenterY,
  };
}

function isPdfRenderCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

export function LibraryItemFullscreenPreview({
  material,
  onClose,
  onUpdate,
}: {
  material: LibraryItem;
  onClose: () => void;
  onUpdate: (updates: LibraryItemPatch) => void;
}) {
  const { t } = useTranslation();
  const currentBody = extractTextFromCommentBody(material.bodyJson);
  const [textDraft, setTextDraft] = useState(() => currentBody);
  const [viewport, setViewport] = useState({ scale: 1, panX: 0, panY: 0 });
  const [previewDragging, setPreviewDragging] = useState(false);
  const previewSurfaceRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  const viewportFrameRef = useRef<number | null>(null);
  const queuedViewportRef = useRef<LibraryItemPreviewViewport | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressSurfaceClickRef = useRef(false);
  const isImagePreview = material.kind === 'image';
  const isPdfPreview = material.kind === 'pdf';
  const isZoomablePreview = isImagePreview || isPdfPreview;
  const assetImageSource = useStoredLibraryItemVariant(
    material,
    'display',
    isImagePreview,
  );
  const assetPdfSource = useStoredLibraryItemVariant(
    material,
    'source',
    isPdfPreview,
  );
  const imageSrc = isImagePreview ? assetImageSource.fileUrl : null;

  const close = useCallback(() => {
    if (material.kind === 'text' && textDraft !== currentBody) {
      onUpdate({ bodyJson: textDraft ? createPlainCommentDoc(textDraft) : null });
    }
    onClose();
  }, [currentBody, material.kind, onClose, onUpdate, textDraft]);

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

  const applyQueuedViewport = useCallback(() => {
    viewportFrameRef.current = null;
    const queued = queuedViewportRef.current;
    queuedViewportRef.current = null;
    if (!queued) return;
    setViewport(queued);
  }, []);

  const queueViewportUpdate = useCallback(
    (update: (current: LibraryItemPreviewViewport) => LibraryItemPreviewViewport) => {
      // The ref is the authoritative in-progress gesture state. React may batch
      // several trackpad wheel events before rendering, so deriving the next
      // delta from rendered state makes zoom and pan appear to jump backwards.
      const next = update(viewportRef.current);
      if (next === viewportRef.current) return;
      viewportRef.current = next;
      queuedViewportRef.current = next;
      if (viewportFrameRef.current !== null) return;
      viewportFrameRef.current = requestAnimationFrame(applyQueuedViewport);
    },
    [applyQueuedViewport],
  );

  useEffect(
    () => () => {
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
      queuedViewportRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const node = previewSurfaceRef.current;
    if (!node || !isZoomablePreview) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const zoomFactor = Math.exp(-event.deltaY * 0.002);
        const rect = node.getBoundingClientRect();
        const anchorFromCenterX = event.clientX - rect.left - rect.width / 2;
        const anchorFromCenterY = event.clientY - rect.top - rect.height / 2;
        queueViewportUpdate((prev) => {
          const scale = clampLibraryItemPreviewScale(prev.scale * zoomFactor);
          return zoomLibraryItemPreviewAt(prev, scale, anchorFromCenterX, anchorFromCenterY);
        });
        return;
      }

      if (viewportRef.current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      queueViewportUpdate((prev) => ({
        ...prev,
        panX: prev.panX - event.deltaX,
        panY: prev.panY - event.deltaY,
      }));
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [isZoomablePreview, queueViewportUpdate]);

  if (material.kind === 'url') return null;

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isZoomablePreview) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    suppressSurfaceClickRef.current = false;
    const currentViewport = viewportRef.current;
    if (currentViewport.scale <= 1) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: currentViewport.panX,
      panY: currentViewport.panY,
    };
    setPreviewDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
      suppressSurfaceClickRef.current = true;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    queueViewportUpdate((current) => ({
      ...current,
      panX: drag.panX + event.clientX - drag.startX,
      panY: drag.panY + event.clientY - drag.startY,
    }));
  };

  const handlePreviewPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = null;
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
      applyQueuedViewport();
      setPreviewDragging(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleSurfaceClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!isZoomablePreview) return;
    if (suppressSurfaceClickRef.current) {
      suppressSurfaceClickRef.current = false;
      return;
    }
    close();
  };

  const content = (() => {
    if (material.kind === 'image') {
      if (!imageSrc) return <FullscreenEmpty message={t('memoMaterial.preview.noImage')} />;
      return (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            // grid item 默认 min-width/min-height: auto 会解析成图片的内在尺寸，
            // 压过上面的 maxWidth/maxHeight，导致超大图溢出屏幕、无法适配。归零解除。
            minWidth: 0,
            minHeight: 0,
            objectFit: 'contain',
            display: 'block',
            transform: `translate3d(${viewport.panX}px, ${viewport.panY}px, 0) scale(${viewport.scale})`,
            transformOrigin: 'center center',
            // Trackpad pinch/pan arrives as a dense wheel stream. A transition
            // here restarts on every delta and makes the image trail the
            // gesture, which reads as shaking in WKWebView.
            transition: 'none',
            willChange: 'transform',
            backfaceVisibility: 'hidden',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      );
    }

    if (material.kind === 'pdf') {
      const pdfPath = assetPdfSource.filePath;
      if (!pdfPath) return <FullscreenEmpty message={t('memoMaterial.preview.noPdf')} />;
      return <PdfCanvasPreview filePath={pdfPath} viewport={viewport} />;
    }

    return (
      <textarea
        autoFocus
        value={textDraft}
        onChange={(event) => setTextDraft(event.target.value)}
        placeholder={t('memoMaterial.card.snippetPlaceholder')}
        style={{
          width: '100%',
          height: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'hsl(var(--paper))',
          color: 'hsl(var(--ink-1))',
          fontFamily: 'var(--font-sans)',
          fontSize: 17,
          lineHeight: 1.65,
          padding: 24,
          whiteSpace: 'pre-wrap',
        }}
      />
    );
  })();

  return createPortal(
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-context-menu)',
        padding: isZoomablePreview ? 0 : '28px 32px',
        background: 'hsl(var(--ink-1) / 0.58)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      <div
        ref={previewSurfaceRef}
        onClick={handleSurfaceClick}
        onPointerDown={handlePreviewPointerDown}
        onPointerMove={handlePreviewPointerMove}
        onPointerUp={handlePreviewPointerEnd}
        onPointerCancel={handlePreviewPointerEnd}
        style={{
          width: isZoomablePreview ? '100%' : 'min(1180px, 100%)',
          height: '100%',
          borderRadius: isImagePreview || isPdfPreview ? 0 : 8,
          overflow: 'hidden',
          background: isZoomablePreview ? 'transparent' : 'hsl(var(--paper))',
          border: isImagePreview || isPdfPreview ? 'none' : '1px solid hsl(var(--rule-strong))',
          boxShadow:
            isImagePreview || isPdfPreview ? 'none' : '0 24px 54px hsl(var(--ink-1) / 0.34)',
          display: 'grid',
          placeItems: 'center',
          cursor:
            isZoomablePreview && viewport.scale > 1
              ? previewDragging
                ? 'grabbing'
                : 'grab'
              : undefined,
          touchAction: isZoomablePreview ? 'none' : 'auto',
          overscrollBehavior: isZoomablePreview ? 'none' : undefined,
        }}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}

function PdfCanvasPreview({
  filePath,
  viewport,
}: {
  filePath: string;
  viewport: LibraryItemPreviewViewport;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [surfaceSize, setSurfaceSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => {
      setSurfaceSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Load via the native platform command rather than handing pdf.js a `file://` URL — WebViews block
  // `fetch('file://…')` from non-file origins (the Vite dev server) regardless
  // of `webSecurity`, so pdf.js's internal fetch silently fails.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    void platform.material
      .readBytes(filePath)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.error('[pdf preview] readBytes failed:', res.error);
          setError(t('memoMaterial.preview.openPdfFailed'));
          return;
        }
        // pdf.js takes ownership of the buffer, so hand it a fresh view.
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(res.bytes) });
        return loadingTask.promise.then((nextDocument) => {
          if (cancelled) {
            return;
          }
          setPdfDocument(nextDocument);
          setPageCount(nextDocument.numPages);
          setPageNumber(1);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[pdf preview] getDocument failed:', err);
        setError(t('memoMaterial.preview.openPdfFailed'));
      });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [filePath, t]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const canvas = canvasRef.current;

    pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return undefined;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, surfaceSize.width - 48);
        const availableHeight = Math.max(240, surfaceSize.height - (pageCount > 1 ? 96 : 48));
        const cssScale = Math.max(
          0.18,
          Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height, 1.8),
        );
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const cssViewport = page.getViewport({ scale: cssScale });
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });

        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;

        renderTask = page.render({
          canvas,
          viewport: renderViewport,
        });
        return renderTask.promise;
      })
      .catch((nextError: unknown) => {
        if (cancelled || isPdfRenderCancel(nextError)) return;
        console.error('[pdf preview] render failed:', nextError);
        setError(t('memoMaterial.preview.renderPdfFailed'));
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber, pageCount, surfaceSize.height, surfaceSize.width, t]);

  const goToPreviousPage = useCallback(() => {
    setPageNumber((page) => Math.max(1, page - 1));
  }, []);
  const goToNextPage = useCallback(() => {
    setPageNumber((page) => Math.min(pageCount, page + 1));
  }, [pageCount]);

  // ←/→ flip pages while the preview is mounted. Skip when the user is
  // typing somewhere (defensive — no inputs live inside this overlay today,
  // but the listener is window-level so any future textarea wins).
  useEffect(() => {
    if (!pdfDocument || pageCount <= 1) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowLeft') goToPreviousPage();
      else goToNextPage();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pdfDocument, pageCount, goToPreviousPage, goToNextPage]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
      }}
    >
      {error ? (
        <FullscreenEmpty message={error} />
      ) : !pdfDocument ? (
        <FullscreenEmpty message={t('memoMaterial.preview.loadingPdf')} />
      ) : (
        <canvas
          ref={canvasRef}
          onClick={(event) => event.stopPropagation()}
          style={{
            display: 'block',
            background: 'hsl(var(--paper))',
            transform: `translate3d(${viewport.panX}px, ${viewport.panY}px, 0) scale(${viewport.scale})`,
            transformOrigin: 'center center',
            transition: 'none',
            willChange: 'transform',
            backfaceVisibility: 'hidden',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      )}

      {pageCount > 1 && (
        <div
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 18,
            transform: 'translateX(-50%)',
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 8px',
            borderRadius: 2,
            border: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper) / 0.88)',
            boxShadow: '0 12px 24px -14px hsl(var(--ink-1) / 0.3)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'hsl(var(--ink-2))',
          }}
        >
          <PdfPageButton onClick={goToPreviousPage} disabled={pageNumber <= 1}>
            {t('memoMaterial.preview.previousPage')}
          </PdfPageButton>
          <span>
            {pageNumber} / {pageCount}
          </span>
          <PdfPageButton onClick={goToNextPage} disabled={pageNumber >= pageCount}>
            {t('memoMaterial.preview.nextPage')}
          </PdfPageButton>
        </div>
      )}
    </div>
  );
}

function PdfPageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        borderRadius: 1,
        background: disabled ? 'transparent' : 'hsl(var(--paper-deep))',
        color: disabled ? 'hsl(var(--ink-5))' : 'hsl(var(--ink-1))',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '3px 7px',
      }}
    >
      {children}
    </button>
  );
}

function FullscreenEmpty({ message }: { message: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 15,
        color: 'hsl(var(--ink-3))',
      }}
    >
      {message}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved TODO archive — slim bottom-pinned drawer for resolved/converted
// TODOs, mirroring the old ResolvedArchive layout but with the simpler
// open/resolved bucket the comment model gives us (no three-state machine).
