import { createContext, useContext } from 'react';

import type { CompleteDesktopCreateTab } from './DesktopCreateCompletionTransition';

export const DesktopCreateCompletionContext =
  createContext<CompleteDesktopCreateTab | null>(null);

export function useDesktopCreateCompletion(): CompleteDesktopCreateTab {
  const completeCreateTab = useContext(DesktopCreateCompletionContext);
  if (!completeCreateTab) {
    throw new Error('Desktop create completion is unavailable outside the desktop shell');
  }
  return completeCreateTab;
}
