import { useEffect, useSyncExternalStore } from 'react';
import { getActiveEditor, subscribeActiveEditor } from '../../../lib/active-editor';
import type { MobilePaper } from './mobile-workspace-session';
import {
  createMobileEditorSearchOwner,
  registerMobilePaperSearchOwner,
} from './mobile-paper-search';

export function MobilePaperSearchOwnerMount({ paper }: { paper: MobilePaper | null }) {
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const paperKey = paper?.key ?? null;
  const entityType = paper?.target.entityType ?? null;

  useEffect(() => {
    if (
      !paperKey ||
      entityType === 'all-chapters' ||
      !editor ||
      editor.isDestroyed
    ) {
      return undefined;
    }
    const owner = createMobileEditorSearchOwner(editor, paperKey);
    const unregister = registerMobilePaperSearchOwner(owner);
    return () => {
      unregister();
      owner.destroy?.();
    };
  }, [editor, entityType, paperKey]);

  return null;
}
