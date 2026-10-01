import { useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import type { EntityKind } from '../../domain/entity-kinds';
import { isProseEntityType } from '../../lib/yjs-doc-id';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useSettingsStore } from '../../store/settings-store';
import { attachAgentDecorationController } from './agent-decoration-controller';

export function useAgentEditorDecorations(editor: Editor | null, kind: EntityKind, id: string, presentationNeeded: boolean): boolean {
  const controller = useRef<ReturnType<typeof attachAgentDecorationController> | null>(null);
  const needed = useRef(presentationNeeded);
  const [readiness, setReadiness] = useState<{ editor: Editor; kind: EntityKind; id: string; ready: boolean } | null>(null);
  useLayoutEffect(() => { needed.current = presentationNeeded; }, [presentationNeeded]);
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || !isProseEntityType(kind)) return;
    const binding = attachAgentDecorationController({
      editor, entityType: kind, entityId: id, store: useAgentEditStore,
      presentationNeeded: needed.current,
      revealAnimationEnabled: useSettingsStore.getState().agentEditRevealAnimation,
      onReady: (ready) => setReadiness({ editor, kind, id, ready }),
      onError: (error) => loglevel.getLogger('AgentEditorDecorations').warn('Failed to build agent diff decorations:', error),
    });
    controller.current = binding;
    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      binding.setRevealAnimationEnabled(state.agentEditRevealAnimation);
    });
    return () => {
      unsubscribeSettings();
      binding.dispose();
      controller.current = null;
    };
  }, [editor, kind, id]);
  useLayoutEffect(() => { controller.current?.setPresentationNeeded(presentationNeeded); }, [presentationNeeded]);
  return !isProseEntityType(kind) || Boolean(readiness?.editor === editor && readiness?.kind === kind && readiness?.id === id && readiness?.ready);
}
