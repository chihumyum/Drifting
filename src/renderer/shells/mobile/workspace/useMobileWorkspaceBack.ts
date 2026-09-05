import { useEffect, useLayoutEffect, useRef, type Dispatch } from 'react';
import { getActiveEditor } from '../../../lib/active-editor';
import { useMobileAndroidBack } from '../useMobileAndroidBack';
import {
  MOBILE_WORKSPACE_BACK_EVENT,
  isMobileWorkspaceBackPreflight,
  requestMobileWorkspaceBack,
  type MobileWorkspaceBackEventDetail,
} from './mobile-workspace-back';
import {
  resolveMobileWorkspaceBack,
  type MobileBackSource,
  type MobileWorkspaceAction,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';

interface MobileWorkspaceBackOptions {
  state: MobileWorkspaceUiState;
  dispatch: Dispatch<MobileWorkspaceAction>;
  onShowProjectHome: () => void;
  onLeaveProject: () => void;
}

export function useMobileWorkspaceBack({
  state,
  dispatch,
  onShowProjectHome,
  onLeaveProject,
}: MobileWorkspaceBackOptions): void {
  const latestRef = useRef({ state, dispatch, onShowProjectHome, onLeaveProject });

  useLayoutEffect(() => {
    latestRef.current = { state, dispatch, onShowProjectHome, onLeaveProject };
  }, [dispatch, onLeaveProject, onShowProjectHome, state]);

  useEffect(() => {
    const apply = (source: MobileBackSource): boolean => {
      const latest = latestRef.current;
      // The mounted Super View stack owns its child layers and root. It consumes
      // the same request in useSuperViewEscapeStack before this shell acts.
      if (latest.state.surface.kind === 'super-view') return false;
      const resolved = resolveMobileWorkspaceBack(latest.state, source);
      if (!resolved.handled) return false;
      if (resolved.effect === 'blur-input' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (resolved.effect === 'focus-editor') {
        const editor = getActiveEditor();
        if (editor && !editor.isDestroyed) {
          // TipTap's mobile focus command is delayed to a later frame. Hand the
          // live editable DOM focus synchronously from Search to ProseMirror,
          // before React can unmount the search field and dismiss the IME.
          editor.view.focus();
        }
      }
      if (resolved.nextState !== latest.state) {
        latest.dispatch({ type: 'replace', state: resolved.nextState });
      }
      if (resolved.effect === 'blur-editor') getActiveEditor()?.commands.blur();
      if (resolved.effect === 'navigate-project-home') latest.onShowProjectHome();
      if (resolved.effect === 'leave-project') latest.onLeaveProject();
      return true;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isMobileWorkspaceBackPreflight(event)
      ) {
        return;
      }
      if (!apply('keyboard')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const handleBackRequest = (event: Event) => {
      const request = event as CustomEvent<MobileWorkspaceBackEventDetail>;
      if (!apply(request.detail.source)) return;
      request.preventDefault();
      request.stopImmediatePropagation();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(MOBILE_WORKSPACE_BACK_EVENT, handleBackRequest);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(MOBILE_WORKSPACE_BACK_EVENT, handleBackRequest);
    };
  }, []);

  useMobileAndroidBack(() => requestMobileWorkspaceBack('android-hardware'));
}
