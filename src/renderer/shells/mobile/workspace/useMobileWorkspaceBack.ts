import { onBackButtonPress } from '@tauri-apps/api/app';
import type { PluginListener } from '@tauri-apps/api/core';
import { useEffect, useLayoutEffect, useRef, type Dispatch } from 'react';
import { getActiveEditor } from '../../../lib/active-editor';
import { getPlatformRuntime } from '../../../platform/runtime';
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

const androidBackConsumers = new Set<() => void>();
let androidBackRegistration: Promise<PluginListener> | null = null;

function ensureAndroidBackRegistration(): void {
  if (androidBackRegistration) return;
  androidBackRegistration = onBackButtonPress(() => {
    const consumers = [...androidBackConsumers];
    const latest = consumers[consumers.length - 1];
    latest?.();
  });
  void androidBackRegistration.catch((error) => {
    androidBackRegistration = null;
    console.error('[mobile workspace] Android hardware Back listener failed:', error);
  });
}

function removeAndroidBackRegistrationWhenIdle(): void {
  const registration = androidBackRegistration;
  if (!registration || androidBackConsumers.size > 0) return;
  void registration.then(async (listener) => {
    if (androidBackRegistration !== registration || androidBackConsumers.size > 0) return;
    androidBackRegistration = null;
    await listener.unregister();
  });
}

function subscribeAndroidHardwareBack(callback: () => void): () => void {
  androidBackConsumers.add(callback);
  ensureAndroidBackRegistration();
  return () => {
    androidBackConsumers.delete(callback);
    removeAndroidBackRegistrationWhenIdle();
  };
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

  useEffect(() => {
    if (getPlatformRuntime().nativePlatform !== 'android') return undefined;
    return subscribeAndroidHardwareBack(() => requestMobileWorkspaceBack('android-hardware'));
  }, []);
}
