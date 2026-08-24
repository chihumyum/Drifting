import { createContext, useContext, useLayoutEffect } from 'react';

export interface EditorSurfaceLifecycleValue {
  /** The surface is the pixels currently presented in the workspace stage. */
  isVisible: boolean;
  /** Global editor commands and entity actions belong to this surface. */
  isCommandActive: boolean;
  /** The surface has canonical content mounted and can be revealed atomically. */
  reportReady(ready: boolean): void;
}

const DEFAULT_LIFECYCLE: EditorSurfaceLifecycleValue = {
  isVisible: true,
  isCommandActive: true,
  reportReady: () => undefined,
};

export const EditorSurfaceLifecycleContext =
  createContext<EditorSurfaceLifecycleValue>(DEFAULT_LIFECYCLE);

export function useEditorSurfaceLifecycle(): EditorSurfaceLifecycleValue {
  return useContext(EditorSurfaceLifecycleContext);
}

/**
 * Publish readiness from a top-level editor view in a layout effect. The stage
 * keeps the previously committed surface visible until this becomes true, then
 * swaps both surfaces before the browser gets another paint.
 */
export function useReportEditorSurfaceReady(ready: boolean): void {
  const { reportReady } = useEditorSurfaceLifecycle();
  useLayoutEffect(() => {
    reportReady(ready);
    return () => reportReady(false);
  }, [ready, reportReady]);
}
