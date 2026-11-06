import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';

/** A pan that starts this close to the left edge pulls the layer back off the desk. */
const EDGE_PX = 24;
import { useTranslation } from 'react-i18next';
import { SuperViewNavigationProvider } from '../../../components/SuperViewNavigationContext';
import { SuperElementView } from '../../../views/SuperViews/SuperElementView';
import { StoryGraphView } from '../../../views/StoryGraphView';
import { SuperMemoMaterialView } from '../../../views/SuperViews/SuperMemoMaterialView';
import type { MobileSuperViewId } from '../desk/mobile-desk-controller';

export function MobileSuperViewHost({
  active,
  onActiveChange,
  returnPointCaptured,
}: {
  active: MobileSuperViewId | null;
  onActiveChange: (view: MobileSuperViewId | null) => void;
  returnPointCaptured: boolean;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const visible = active !== null;
  const navigation = useMemo(
    () => ({
      active: active ?? ('none' as const),
      setActive: (view: MobileSuperViewId | 'none') =>
        onActiveChange(view === 'none' ? null : view),
    }),
    [active, onActiveChange],
  );

  useEffect(() => {
    if (!visible) return undefined;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const back = hostRef.current?.querySelector<HTMLElement>('.super-view-head__back');
      (back ?? hostRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [visible]);

  // The layer lies over the desk from the right; a pan from the left edge
  // drags it back off, and past a third of the way (or a flick) it goes,
  // as Back would take it (docs/design-system/touch.md).
  const edgeRef = useRef<{ id: number; x: number; t: number; dx: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.clientX > EDGE_PX) return;
    edgeRef.current = { id: event.pointerId, x: event.clientX, t: performance.now(), dx: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const edge = edgeRef.current;
    const host = hostRef.current;
    if (!edge || edge.id !== event.pointerId || !host) return;
    edge.dx = Math.max(0, event.clientX - edge.x);
    if (edge.dx > 6) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      host.style.transition = 'none';
      host.style.transform = `translate3d(${edge.dx}px, 0, 0)`;
    }
  };
  const onPointerEnd = () => {
    const edge = edgeRef.current;
    const host = hostRef.current;
    edgeRef.current = null;
    if (!edge || !host || edge.dx <= 6) return;
    const velocity = edge.dx / Math.max(1, performance.now() - edge.t);
    host.style.transition = '';
    host.style.transform = '';
    if (edge.dx > host.clientWidth / 3 || velocity > 0.5) requestMobileWorkspaceBack('visible');
  };

  if (!active) return null;
  return (
    <div
      ref={hostRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className="m-super-view-host"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobileWorkspace.superView.label')}
      tabIndex={-1}
      data-active-super-view={active}
      data-return-point={returnPointCaptured ? 'captured' : 'missing'}
      data-gesture-owner="super-view"
    >
      <SuperViewNavigationProvider value={navigation}>
        {active === 'element' && <SuperElementView />}
        {active === 'graph' && <StoryGraphView />}
        {active === 'memo-material' && <SuperMemoMaterialView />}
      </SuperViewNavigationProvider>
    </div>
  );
}
