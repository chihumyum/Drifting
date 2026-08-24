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
  isCommandActive,
  onReadyChange,
  children,
}: {
  isVisible: boolean;
  isCommandActive: boolean;
  onReadyChange(ready: boolean): void;
  children: ReactNode;
}) {
  const value = useMemo<EditorSurfaceLifecycleValue>(
    () => ({ isVisible, isCommandActive, reportReady: onReadyChange }),
    [isCommandActive, isVisible, onReadyChange],
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
