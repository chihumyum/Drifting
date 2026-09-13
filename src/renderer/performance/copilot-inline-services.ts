// Isolated browser acceptance doubles. The runner redirects only the popover's
// service imports; normal app builds never import this module or send requests.
import type { runInlineEdit as edit, InlineEditResult } from '../lib/copilot/inline-edit';
import type { runInlineAskStream as ask } from '../lib/copilot/inline-ask';
import type { generateChapterSummary as summary, ReverseChapterSummaryResult } from '../lib/copilot/reverse-chapter-summary';
export { applyInlineEdit } from '../lib/copilot/inline-edit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const inlineServiceCalls = {
  edits: [] as Array<ReturnType<typeof deferred<InlineEditResult>> & { signal?: AbortSignal }>,
  asks: [] as Array<ReturnType<typeof deferred<string>> & { signal?: AbortSignal }>,
  summaries: [] as Array<ReturnType<typeof deferred<ReverseChapterSummaryResult>>>,
};
export const runInlineEdit: typeof edit = params => {
  const call = { ...deferred<InlineEditResult>(), signal: params.signal };
  inlineServiceCalls.edits.push(call); return call.promise;
};
export const runInlineAskStream: typeof ask = async function* (params) {
  const call = { ...deferred<string>(), signal: params.signal };
  inlineServiceCalls.asks.push(call);
  // Intentionally deliver after abort, reproducing a late provider completion.
  yield await call.promise;
};
export const generateChapterSummary: typeof summary = () => {
  const call = deferred<ReverseChapterSummaryResult>();
  inlineServiceCalls.summaries.push(call); return call.promise;
};
