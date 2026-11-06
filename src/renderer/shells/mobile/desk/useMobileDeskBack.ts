import { useEffect, useLayoutEffect, useRef, type Dispatch } from 'react';
import { getActiveEditor } from '../../../lib/active-editor';
import { useMobileAndroidBack } from '../useMobileAndroidBack';
import {
  MOBILE_WORKSPACE_BACK_EVENT,
  isMobileWorkspaceBackPreflight,
  requestMobileWorkspaceBack,
  type MobileWorkspaceBackEventDetail,
} from '../workspace/mobile-workspace-back';
import {
  resolveMobileDeskBack,
  type MobileBackSource,
  type MobileDeskAction,
  type MobileDeskState,
} from './mobile-desk-controller';

/**
 * Escape, the visible back controls and Android's Back all take away one
 * thing from the desk (resolveMobileDeskBack). A dialog or popover in the DOM
 * answers Escape first; an open Super View answers through its own stack.
 */
export function useMobileDeskBack({ state, dispatch, onShowHome, onLeaveBook }: {
  state: MobileDeskState;
  dispatch: Dispatch<MobileDeskAction>;
  onShowHome: () => void;
  onLeaveBook: () => void;
}): void {
  const latest = useRef({ state, dispatch, onShowHome, onLeaveBook });
  useLayoutEffect(() => {
    latest.current = { state, dispatch, onShowHome, onLeaveBook };
  }, [dispatch, onLeaveBook, onShowHome, state]);

  useEffect(() => {
    const apply = (source: MobileBackSource): boolean => {
      const current = latest.current;
      // The mounted Super View owns its own layers and its root (useSuperViewEscapeStack).
      if (current.state.superView) return false;
      const resolved = resolveMobileDeskBack(current.state, source);
      if (!resolved.handled) return false;
      if (resolved.nextState !== current.state) current.dispatch({ type: 'replace', state: resolved.nextState });
      if (resolved.effect === 'blur-editor') getActiveEditor()?.commands.blur();
      if (resolved.effect === 'show-home') current.onShowHome();
      if (resolved.effect === 'leave-project') current.onLeaveBook();
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isMobileWorkspaceBackPreflight(event)) return;
      if (!apply('keyboard')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onBack = (event: Event) => {
      const request = event as CustomEvent<MobileWorkspaceBackEventDetail>;
      if (!apply(request.detail.source)) return;
      request.preventDefault();
      request.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(MOBILE_WORKSPACE_BACK_EVENT, onBack);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(MOBILE_WORKSPACE_BACK_EVENT, onBack);
    };
  }, []);

  useMobileAndroidBack(() => requestMobileWorkspaceBack('android-hardware'));
}
