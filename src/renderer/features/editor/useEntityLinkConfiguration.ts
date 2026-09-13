import { useEffect, useLayoutEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { useDataStore } from '../../store/data-store';
import { resolveEntityLinkTargetState } from '../../lib/entity-link-target-state';
import { useSettingsStore } from '../../store/settings-store';
import { buildEntityLinkColorSignature, resolveEntityLinkTargetColor } from '../../lib/entity-link-appearance';
import { configureEntityLinkAutoDetect, entityLinkConfig, EntityLinkDanglingPluginKey, type EntityLinkAutoDetectConfig } from '../../lib/extensions/entity-link';

/** Per-view auto-detection and shared appearance are separate configuration domains. */
export function useEntityLinkConfiguration(editor: Editor | null, { autoDetectTargets, autoDetectEnabled }: EntityLinkAutoDetectConfig): void {
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const entityLinkColorMode = useSettingsStore((state) => state.entityLinkColorMode);
  const entityLinkKindColors = useSettingsStore((state) => state.entityLinkKindColors);
  const trashedEntityIds = useDataStore((state) => state.trashedEntityIds);
  const entityLinkColorSignature = useDataStore((state) =>
    buildEntityLinkColorSignature(state, entityLinkColorMode, entityLinkKindColors),
  );
  useLayoutEffect(() => {
    if (editor) configureEntityLinkAutoDetect(editor, { autoDetectTargets, autoDetectEnabled });
  }, [editor, autoDetectTargets, autoDetectEnabled]);

  useEffect(() => {
    entityLinkConfig.interactionEnabled = entityLinkInteractive;
    // Read the store live at resolve/click time so a link whose target was just
    // deleted (its mark still embedded in this doc's content) is treated as
    // non-alive: dimmed if the target sits in the trash (recoverable), stripped
    // if it's gone for good — and never opens a phantom "untitled" editor.
    entityLinkConfig.resolveTargetState = (kind, id) =>
      resolveEntityLinkTargetState(useDataStore.getState(), kind, id);
    entityLinkConfig.resolveTargetColor = (kind, id) => {
      const state = useDataStore.getState();
      return resolveEntityLinkTargetColor(
        kind,
        id,
        state,
        entityLinkColorMode,
        entityLinkKindColors,
      );
    };
    entityLinkConfig.targetColorVersion += 1;
    // The known-entity / trashed set just changed (e.g. an element was deleted,
    // trashed, or restored while this doc is open). Nudge the dangling-link
    // plugin to re-walk so links re-style immediately. A meta-only transaction
    // adds no steps and never enters history.
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(EntityLinkDanglingPluginKey, true));
    }
  }, [
    autoDetectTargets,
    entityLinkColorSignature,
    entityLinkColorMode,
    entityLinkKindColors,
    entityLinkInteractive,
    trashedEntityIds,
    editor,
  ]);

}
