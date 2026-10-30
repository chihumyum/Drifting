import { createContext, useContext } from 'react';

/**
 * True inside a Super View that a switch is pushing away
 * (`DesktopSuperViewStage`): it stays on screen until the push rests, but
 * takes no input and keeps only an empty header.
 */
export const SuperViewLeavingContext = createContext(false);

export function useSuperViewLeaving() {
  return useContext(SuperViewLeavingContext);
}
