import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { configureEntityLinkAutoDetect, refreshEntityLinkPresentation, setEntityLinkPresentationNeeded, type EntityLinkAutoDetectConfig } from '../../lib/extensions/entity-link';
import { entityLinkPresentationRegistry } from './entity-link-presentation-registry';

/** Auto-detection belongs to the view; shared display inputs have one subscriber. */
export function useEntityLinkConfiguration(editor: Editor | null, { autoDetectTargets, autoDetectEnabled }: EntityLinkAutoDetectConfig,
  { canonicalReady = true, presentationNeeded = true } = {}): boolean {
  const owner = useMemo(() => ({ editor, canonicalReady }), [editor, canonicalReady]);
  const needed = useRef(presentationNeeded);
  const prepare = useRef<((needed: boolean) => void) | null>(null);
  const [readiness, setReadiness] = useState<{ owner: typeof owner; needed: boolean; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    if (editor && !editor.isDestroyed) configureEntityLinkAutoDetect(editor, { autoDetectTargets, autoDetectEnabled });
  }, [editor, autoDetectTargets, autoDetectEnabled]);
  useLayoutEffect(() => { needed.current = presentationNeeded; }, [presentationNeeded]);
  useLayoutEffect(() => {
    const { editor, canonicalReady } = owner;
    if (!editor || editor.isDestroyed || !canonicalReady) return;
    let disposed = false;
    const refresh = (targetsChanged: boolean) => {
      if (disposed || editor.isDestroyed) return;
      try {
        refreshEntityLinkPresentation(editor, targetsChanged);
        setReadiness(current => current?.owner === owner && current.needed === needed.current && current.ready
          ? current : { owner, needed: needed.current, ready: true });
      } catch (error) {
        setReadiness({ owner, needed: needed.current, ready: false });
        loglevel.getLogger('EntityLinkPresentation').warn('Failed to refresh entity link display:', error);
      }
    };
    const setNeeded = (value: boolean) => {
      if (disposed || editor.isDestroyed) return;
      setEntityLinkPresentationNeeded(editor, value); refresh(false);
    };
    setEntityLinkPresentationNeeded(editor, needed.current);
    const off = entityLinkPresentationRegistry.attach(change => refresh(change.targetsChanged));
    prepare.current = setNeeded;
    return () => {
      disposed = true; off(); prepare.current = null;
      if (!editor.isDestroyed) setEntityLinkPresentationNeeded(editor, false);
    };
  }, [owner]);
  useLayoutEffect(() => { prepare.current?.(presentationNeeded); }, [presentationNeeded]);
  // An incoming render must wait for layout preparation, including hidden Yjs
  // updates. Neither a previously ready hidden snapshot nor another editor fits.
  return canonicalReady && (!presentationNeeded || Boolean(readiness?.owner === owner && readiness.needed && readiness.ready));
}
