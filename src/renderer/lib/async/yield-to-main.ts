/**
 * Cooperative yield to the event loop so the browser can paint / handle input
 * between chunks of main-thread work.
 *
 * The shadow review's LLM orchestration AND its tool execution run on the render
 * thread; some tool calls do heavy synchronous bursts (Y.Doc hydration → ProseMirror
 * JSON, scanning every element against the full prose). Awaiting on network/DB IPC
 * yields naturally, but a long CPU burst does not — so we sprinkle `yieldToMain()`
 * through the hot paths to keep the UI responsive during a review.
 *
 * Prefers `scheduler.yield()` (recent embedded webviews — prioritized continuation,
 * no clamp). Falls back to a shared MessageChannel macrotask, which (unlike
 * setTimeout(0)) is not subject to the 4ms nested-timeout clamp.
 */
type SchedulerLike = { yield?: () => Promise<void> };

let port: MessagePort | null = null;
let pending: Array<() => void> = [];

function macrotaskYield(): Promise<void> {
  if (!port) {
    const channel = new MessageChannel();
    port = channel.port2;
    channel.port1.onmessage = () => {
      const batch = pending;
      pending = [];
      for (const resolve of batch) resolve();
    };
    channel.port1.start();
  }
  return new Promise<void>((resolve) => {
    pending.push(resolve);
    port!.postMessage(null);
  });
}

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return macrotaskYield();
}
