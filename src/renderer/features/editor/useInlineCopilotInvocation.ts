import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../../store/copilot-inline-store';
import { trackInlineEditSpan } from '../../lib/copilot/inline-edit-apply';

/** Owns transient requests and the captured context, never the live prose. */
export function useInlineCopilotInvocation(editor: Editor, ctx: CopilotInlineCtx | null) {
  const active = useRef<CopilotInlineCtx | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (!ctx) return;
    const close = useCopilotInlineStore.getState().close;
    if (editor.isDestroyed || !editor.isEditable) { close(ctx); return; }
    active.current = ctx;
    const releaseSpan = ctx.spanSource ? trackInlineEditSpan(editor, ctx.spanSource) : () => {};
    const releaseRequest = () => { abortRef.current?.abort(); abortRef.current = null; };
    const release = () => {
      if (active.current === ctx) active.current = null;
      releaseRequest(); close(ctx);
    };
    const onUpdate = () => { if (!editor.isEditable) release(); };
    editor.on('destroy', release); editor.on('update', onUpdate);
    return () => {
      editor.off('destroy', release); editor.off('update', onUpdate);
      releaseSpan();
      if (active.current === ctx) active.current = null;
      releaseRequest();
      // React StrictMode can immediately reacquire the same invocation. Delay
      // only store cleanup until the microtask; requests stop synchronously.
      queueMicrotask(() => { if (active.current !== ctx) close(ctx); });
    };
  }, [ctx, editor]);
  const isCurrent = useCallback(() => Boolean(ctx && active.current === ctx
    && useCopilotInlineStore.getState().ctx === ctx && !editor.isDestroyed && editor.isEditable), [ctx, editor]);
  return { abortRef, isCurrent };
}
