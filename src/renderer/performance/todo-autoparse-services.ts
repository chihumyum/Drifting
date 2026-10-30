// Only the isolated browser runner redirects useTodoAutoParse's comment service here.
import type { CreateCommentInput } from '../usecase/useComment';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const todoAutoParseCalls = {
  todos: [] as CreateCommentInput[],
  deletedTodos: [] as string[],
  blockedTodoWrite: null as ReturnType<typeof deferred<void>> | null,
};
const createComment = async (input: CreateCommentInput) => { todoAutoParseCalls.todos.push(input); await todoAutoParseCalls.blockedTodoWrite?.promise; };
const deleteComment = async (id: string) => { todoAutoParseCalls.deletedTodos.push(id); await todoAutoParseCalls.blockedTodoWrite?.promise; };
export function useComment() { return { createComment, deleteComment }; }
