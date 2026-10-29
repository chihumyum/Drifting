import { createContext, useContext } from 'react';

export type BottomPanelPane = 'timeline' | 'planner';

export const BOTTOM_PANEL_DEFAULT_HEIGHT = 180;

export interface BottomPanelApi {
  /** The panel's height in px, shared by both panes. */
  height: number;
  /** Set the shared height (clamped to the desk column) and remember it. */
  setHeight: (next: number) => void;
  /** The least this pane can be dragged down to (the timeline's lanes). */
  setMinHeight: (min: number) => void;
}

export const BottomPanelContext = createContext<BottomPanelApi | null>(null);

/** The Bottom Panel a pane sits in; null outside one (the paused mobile shell). */
export function useBottomPanel(): BottomPanelApi | null {
  return useContext(BottomPanelContext);
}
