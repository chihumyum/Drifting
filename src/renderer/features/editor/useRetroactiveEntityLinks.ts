import { useLayoutEffect } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import type { EditorSessionSource } from './entity-editor-session';
import { editorElementCreatedRegistry } from './project-element-created-registry';
import { isEntityLinkAutoDetectEnabled, linkEntityInDoc } from '../../lib/extensions/entity-link';

interface Source extends EditorSessionSource {
  canonicalReady: boolean;
  parentElementId?: string;
}

/** Hidden canonical sessions still own prose; visibility does not gate linking. */
export function useRetroactiveEntityLinks(editor: Editor | null, source: Source): void {
  const { projectId, sourceKind, sourceId, parentElementId, canonicalReady } = source;
  useLayoutEffect(() => {
    if (!editor || !canonicalReady || !projectId || !sourceId) return;
    return editorElementCreatedRegistry.attach(projectId, element => {
      if (editor.isDestroyed || !isEntityLinkAutoDetectEnabled(editor)) return;
      if ((sourceKind === 'element' && element.id === sourceId) || element.id === parentElementId) return;
      try {
        linkEntityInDoc(editor, { kind: 'element', id: element.id, names: [element.name, ...element.aliases] });
      } catch (error) {
        loglevel.getLogger('useEntityEditor').warn('Retroactive entity link failed:', error);
      }
    });
  }, [editor, canonicalReady, projectId, sourceKind, sourceId, parentElementId]);
}
