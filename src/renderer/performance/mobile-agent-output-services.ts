import { useMemo } from 'react';
import type { useBookNode as RealUseBookNode } from '../usecase/useBookNode';
import type { useComment as RealUseComment } from '../usecase/useComment';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Owner = Parameters<typeof RealUseBookNode>[0];
type NodeInput = Parameters<ReturnType<typeof RealUseBookNode>['createNode']>[0];
type CommentInput = Parameters<ReturnType<typeof RealUseComment>['createComment']>[0];
export const mobileAgentOutputs = {
  nodes: [] as Array<Owner & { input: NodeInput } & ReturnType<typeof deferred<{ id: string }>>>,
  comments: [] as Array<Owner & { input: CommentInput } & ReturnType<typeof deferred<void>>>,
  copies: [] as Array<{ text: string } & ReturnType<typeof deferred<void>>>,
  copy(text: string) { const call = { text, ...deferred<void>() }; this.copies.push(call); return call.promise; },
};
export function useBookNode({ projectId, userId }: Owner) {
  return useMemo(() => ({ createNode(input: NodeInput) {
    const call = { projectId, userId, input, ...deferred<{ id: string }>() }; mobileAgentOutputs.nodes.push(call); return call.promise;
  } }), [projectId, userId]);
}
export function useComment({ projectId, userId }: Owner) {
  return useMemo(() => ({ createComment(input: CommentInput) {
    const call = { projectId, userId, input, ...deferred<void>() }; mobileAgentOutputs.comments.push(call); return call.promise;
  } }), [projectId, userId]);
}
