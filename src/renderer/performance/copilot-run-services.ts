// Only the isolated browser runner redirects useCopilot's service imports here.
import type { BaseBlockContext } from '../lib/ai/context/types';
import type { CreateCommentInput, CreateCopilotSuggestionInput } from '../usecase/useComment';
import type { ProduceBlockSectionSummaryInput } from '../lib/copilot/produce-block-section-summary';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const copilotRunCalls = {
  contexts: [] as Array<ReturnType<typeof deferred<BaseBlockContext | null>>>,
  writes: [] as CreateCopilotSuggestionInput[],
  summaries: [] as Array<ProduceBlockSectionSummaryInput & ReturnType<typeof deferred<void>>>,
  blockedWrite: null as ReturnType<typeof deferred<void>> | null,
  todos: [] as CreateCommentInput[],
  deletedTodos: [] as string[],
  blockedTodoWrite: null as ReturnType<typeof deferred<void>> | null,
};
export function buildBaseBlockContext() {
  const call = deferred<BaseBlockContext | null>(); copilotRunCalls.contexts.push(call); return call.promise;
}
export function buildSelectionBlockContext() { return null; }
export function selectionWarrantsSummaryRegen() { return false; }
const createCopilotSuggestion = async (input: CreateCopilotSuggestionInput) => { copilotRunCalls.writes.push(input); await copilotRunCalls.blockedWrite?.promise; };
const createComment = async (input: CreateCommentInput) => { copilotRunCalls.todos.push(input); await copilotRunCalls.blockedTodoWrite?.promise; };
const deleteComment = async (id: string) => { copilotRunCalls.deletedTodos.push(id); await copilotRunCalls.blockedTodoWrite?.promise; };
export function useComment() { return { createCopilotSuggestion, createComment, deleteComment }; }
export function produceBlockSectionSummary(input: ProduceBlockSectionSummaryInput) {
  const call = { ...input, ...deferred<void>() }; copilotRunCalls.summaries.push(call); return call.promise;
}
