import { onBackButtonPress } from '@tauri-apps/api/app';
import type { PluginListener } from '@tauri-apps/api/core';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { getPlatformRuntime } from '../../platform/runtime';

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
    console.error('[mobile shell] Android hardware Back listener failed:', error);
  });
}

function removeAndroidBackRegistrationWhenIdle(): void {
  const registration = androidBackRegistration;
  if (!registration || androidBackConsumers.size > 0) return;
  void registration
    .then(async (listener) => {
      if (androidBackRegistration !== registration || androidBackConsumers.size > 0) return;
      androidBackRegistration = null;
      await listener.unregister();
    })
    .catch(() => {
      // Registration failures are already reported by ensureAndroidBackRegistration;
      // an unregister failure must not become an unhandled rejection during unmount.
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

/**
 * One app-wide Tauri AppPlugin subscription serves the currently mounted
 * compact-shell owner. The newest mounted layer wins without installing a
 * second native listener.
 */
export function useMobileAndroidBack(callback: () => void): void {
  const latestRef = useRef(callback);

  useLayoutEffect(() => {
    latestRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (getPlatformRuntime().nativePlatform !== 'android') return undefined;
    return subscribeAndroidHardwareBack(() => latestRef.current());
  }, []);
}
