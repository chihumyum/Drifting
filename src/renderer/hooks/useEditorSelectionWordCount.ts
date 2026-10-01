import { useMemo, useSyncExternalStore } from 'react';
import { createEditorSelectionWordCountStore } from '../features/editor/editor-selection-word-count';

const getServerSnapshot = () => null;

export function useEditorSelectionWordCount(): number | null {
  const store = useMemo(() => createEditorSelectionWordCountStore(), []);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
