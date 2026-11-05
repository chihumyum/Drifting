// What the first run leaves on the desktop shelf (docs/design-system/components.md,
// "全屏加载与字海"): the shelf coming up from the first-run card, and the
// sample this launch wrote landing on it and waiting there until it is opened.
// It is likely the first book opened on this device, which is where the
// workspace tour takes over (shells/desktop/WorkspaceGuide.tsx).

import { createContext, useContext } from 'react';
import { create } from 'zustand';
import { useBuiltInSampleStore } from '../../services/built-in-sample/first-run';

/**
 * True while the shelf comes up from the first-run card: glass mounted then
 * is set down on the sea (its resting line settles in) instead of standing.
 */
export const FirstRunArrival = createContext(false);

export function useFirstRunArrival(): boolean {
  return useContext(FirstRunArrival);
}

interface FirstRunShelfState {
  /** The sample's landing ring is spent; a shelf mounted later shows it in place. */
  sampleLanded: boolean;
  /** The sample was opened: it no longer waits on the shelf. */
  sampleOpened: boolean;
}

const useFirstRunShelfStore = create<FirstRunShelfState>(() => ({ sampleLanded: false, sampleOpened: false }));

/**
 * The sample this launch wrote, as the shelf shows it: whether it still waits
 * for the author, and whether its card has yet to land.
 */
export function useSampleOnShelf(projectId: string): { waiting: boolean; landing: boolean } {
  const created = useBuiltInSampleStore((state) => state.createdProjectIds.includes(projectId));
  const { sampleLanded, sampleOpened } = useFirstRunShelfStore();
  const waiting = created && !sampleOpened;
  return { waiting, landing: waiting && !sampleLanded };
}

export function markSampleLanded(): void {
  useFirstRunShelfStore.setState({ sampleLanded: true });
}

/** A book opened from the shelf: once a sample is opened, the samples wait no longer. */
export function noteBookOpened(projectId: string): void {
  if (!useBuiltInSampleStore.getState().createdProjectIds.includes(projectId)) return;
  useFirstRunShelfStore.setState({ sampleOpened: true });
}
