import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { getPlatformRuntime } from '../../platform/runtime';

export type AuthEntryMode = 'signin' | 'signup';

interface AuthDialogState {
  /** A fresh id per request so reopening always starts a clean flow. */
  request: { id: number; mode: AuthEntryMode } | null;
  open(mode: AuthEntryMode): void;
  close(): void;
}

let nextRequestId = 0;

export const useAuthDialogStore = create<AuthDialogState>()((set) => ({
  request: null,
  open: (mode) => set({ request: { id: ++nextRequestId, mode } }),
  close: () => set({ request: null }),
}));

/**
 * Desktop signs in with a dialog over the current screen; the mobile shell
 * keeps its full-page authentication route.
 */
export function useOpenSignIn() {
  const navigate = useNavigate();
  return useCallback(
    (mode: AuthEntryMode = 'signin') => {
      if (getPlatformRuntime().isMobileShell) navigate(mode === 'signup' ? '/register' : '/login');
      else useAuthDialogStore.getState().open(mode);
    },
    [navigate],
  );
}
