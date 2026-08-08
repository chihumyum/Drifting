const NATIVE_GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

export function disableMobileWebViewZoom(documentRoot: Document = document): () => void {
  const viewport = documentRoot.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const previousViewport = viewport?.content ?? null;
  if (viewport) {
    viewport.content =
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
  }

  const preventNativeZoom = (event: Event) => event.preventDefault();
  for (const eventName of NATIVE_GESTURE_EVENTS) {
    documentRoot.addEventListener(eventName, preventNativeZoom, { passive: false });
  }

  return () => {
    for (const eventName of NATIVE_GESTURE_EVENTS) {
      documentRoot.removeEventListener(eventName, preventNativeZoom);
    }
    if (viewport && previousViewport !== null) viewport.content = previousViewport;
  };
}
