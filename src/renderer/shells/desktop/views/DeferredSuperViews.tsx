import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { useDriftPanelAnim } from '../../../hooks/useDriftPanelAnim';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { superViewModules } from '../deferred-super-view-modules';
// These shells/styles are immediate, including while feature code is loading.
import '../../../../styles/graph-view.css';
import '../../../../styles/drift-panel.css';
import '../../../../styles/relation-edge-popover.css';

function PendingSuperView({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  const { setActive } = useSuperViewNavigation();
  const close = useCallback(() => setActive('none'), [setActive]);
  useSuperViewEscapeStack([], close);
  return (
    <SuperViewShell>
      <DesktopSuperViewHeader onBack={close} />
      <div className="set-panel" role={failed ? 'alert' : 'status'} aria-live="polite">
        <p className="set-panel__sub">{t(failed ? 'appShell.viewLoadFailed' : 'common.loading')}</p>
        {failed && <button type="button" className="set-btn" onClick={retry}>{t('appShell.retry')}</button>}
      </div>
    </SuperViewShell>
  );
}

function DeferredSuperView({ view }: { view: keyof typeof superViewModules }) {
  const resource = superViewModules[view];
  const driftPanel = useDriftPanelAnim();
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (state.status === 'idle') void resource.load();
  }, [resource, state.status]);
  useLayoutEffect(() => {
    if (state.status === 'ready' && restoreFocus.current && document.activeElement === document.body) {
      hostRef.current?.querySelector<HTMLElement>('.super-view-head__back')?.focus({ preventScroll: true });
    }
  }, [state.status]);
  const ready = state.status === 'ready' ? state.value : null;
  return (
    <div ref={hostRef} style={{ display: 'contents' }}
      onFocusCapture={() => { restoreFocus.current = true; }}
      onBlurCapture={(event) => {
        // Removing Retry while loading can report body as the blur target.
        // Preserve that focus intent, but respect focus moved to another control.
        if (event.relatedTarget && event.relatedTarget !== document.body && !event.currentTarget.contains(event.relatedTarget)) {
          restoreFocus.current = false;
        }
      }}
    >
      {ready ? <ready.View graphUi={ready.graphUi} driftPanel={driftPanel} />
        : <PendingSuperView failed={state.status === 'error'} retry={resource.load} />}
    </div>
  );
}

export function DeferredStoryGraphView() { return <DeferredSuperView view="graph" />; }
export function DeferredElementGraphView() { return <DeferredSuperView view="element" />; }
