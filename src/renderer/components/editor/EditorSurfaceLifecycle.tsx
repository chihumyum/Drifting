import {
  useMemo,
  type ReactNode,
} from 'react';
import {
  EditorSurfaceLifecycleContext,
  useReportEditorSurfaceReady,
  type EditorSurfaceLifecycleValue,
} from './editor-surface-lifecycle-context';

export function EditorSurfaceLifecycleProvider({
  isVisible,
  isPreparing = false,
  isCommandActive,
  onReadyChange,
  children,
}: {
  isVisible: boolean;
  isPreparing?: boolean;
  isCommandActive: boolean;
  onReadyChange(ready: boolean): void;
  children: ReactNode;
}) {
  const value = useMemo<EditorSurfaceLifecycleValue>(
    () => ({ isVisible, isPreparing, isCommandActive, reportReady: onReadyChange }),
    [isCommandActive, isVisible, isPreparing, onReadyChange],
  );
  return (
    <EditorSurfaceLifecycleContext.Provider value={value}>
      {children}
    </EditorSurfaceLifecycleContext.Provider>
  );
}

export function ImmediateEditorSurfaceReady({ children }: { children: ReactNode }) {
  useReportEditorSurfaceReady(true);
  return children;
}
