import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SuperViewNavigationProvider } from '../../../components/SuperViewNavigationContext';
import { SuperElementView } from '../../../views/SuperViews/SuperElementView';
import { StoryGraphView } from '../../../views/StoryGraphView';
import { SuperMemoMaterialView } from '../../../views/SuperViews/SuperMemoMaterialView';
import type { MobileSuperViewId } from './mobile-workspace-controller';

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

  if (!active) return null;
  return (
    <div
      ref={hostRef}
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
