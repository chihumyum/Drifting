import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/core';
import { useRegisterActiveEditor } from '../../hooks/useRegisterActiveEditor';
import { EMPTY_EDITOR_SESSION_SNAPSHOT, EntityEditorSession, type EditorPersistDerived, type EditorSessionSource } from './entity-editor-session';

interface SessionConfig extends EditorSessionSource {
  canonicalReady: boolean;
  presentationNeeded: boolean;
  isCommandActive: boolean;
  selectionKey?: string | null;
  autoFocus?: boolean;
  onPersist(editor: Editor, derived: EditorPersistDerived): void;
}
const subscribeEmpty = () => () => undefined;
const getEmptySnapshot = () => EMPTY_EDITOR_SESSION_SNAPSHOT;

export function useEntityEditorSession(editor: Editor | null, config: SessionConfig) {
  const { projectId, sourceKind, sourceId, canonicalReady, presentationNeeded,
    isCommandActive, onPersist, selectionKey = null, autoFocus = false } = config;
  const session = useMemo(() => editor && canonicalReady && sourceId
    ? new EntityEditorSession(editor, { projectId, sourceKind, sourceId }) : null,
  [editor, canonicalReady, projectId, sourceKind, sourceId]);
  const snapshot = useSyncExternalStore(session?.subscribe ?? subscribeEmpty, session?.getSnapshot ?? getEmptySnapshot, getEmptySnapshot);

  // Layout cleanup retires the old identity before a new owner receives its
  // callbacks. Ordinary callback refreshes do not detach listeners or timers.
  useLayoutEffect(() => {
    session?.updateOptions({ onPersist, selectionKey, autoFocus, isCommandActive });
  }, [session, onPersist, selectionKey, autoFocus, isCommandActive]);
  useLayoutEffect(() => { session?.setPresentationNeeded(presentationNeeded); }, [session, presentationNeeded]);
  useLayoutEffect(() => session?.attach(), [session]);

  useRegisterActiveEditor(editor, session?.saveNow, {
    isSurfaceActive: canonicalReady && isCommandActive,
    activateOnMount: sourceKind !== 'patch',
  });
  return {
    outline: snapshot.outline,
    // During hidden → preparing render, the session is still hidden. Its
    // layout preparation must publish before the stage can reveal this view.
    ready: Boolean(session && (!presentationNeeded || (session.needsPresentation() && snapshot.ready))),
  };
}
