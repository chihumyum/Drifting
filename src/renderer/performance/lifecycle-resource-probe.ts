/** Test-only counters. Global listeners retain their callbacks anyway; ordinary
 * DOM listeners are deliberately left alone so this probe cannot pin DOM trees. */
export function installLifecycleResourceProbe() {
  const restores: (() => void)[] = [];
  const listeners = new Set<object>();
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const entries: { type: string; callback: EventListenerOrEventListenerObject; capture: boolean; wrapped: EventListener; retire(): void }[] = [];
    target.addEventListener = ((type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (!callback) return;
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const signal = typeof options === 'object' ? options.signal : undefined;
      if (signal?.aborted || entries.some(e => e.type === type && e.callback === callback && e.capture === capture)) return;
      const entry = { type, callback, capture, wrapped: ((event: Event) => {
        if (typeof options === 'object' && options.once) entry.retire();
        if (typeof callback === 'function') callback.call(target, event); else callback.handleEvent(event);
      }), retire() {
        listeners.delete(entry);
        const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1);
        signal?.removeEventListener('abort', entry.retire);
      } };
      listeners.add(entry); entries.push(entry);
      signal?.addEventListener('abort', entry.retire, { once: true });
      add(type, entry.wrapped, options);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const entry = entries.find(e => e.type === type && e.callback === callback && e.capture === capture);
      if (entry) { remove(type, entry.wrapped, options); entry.retire(); } else remove(type, callback as EventListener, options);
    }) as typeof target.removeEventListener;
    restores.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
  }
  const timeouts = new Set<number>(), intervals = new Set<number>(), frames = new Set<number>();
  const timeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
  const interval = window.setInterval.bind(window), clearInterval = window.clearInterval.bind(window);
  const frame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = timeout(() => { timeouts.delete(id); if (typeof callback === 'function') callback(...args); }, ms);
    timeouts.add(id); return id;
  }) as typeof window.setTimeout;
  // These production fixtures use function callbacks, never string evaluation.
  window.clearTimeout = ((id?: number) => { if (id !== undefined) { timeouts.delete(id); intervals.delete(id); } clearTimeout(id); }) as typeof window.clearTimeout;
  window.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = interval(callback, ms, ...args); intervals.add(id); return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => { if (id !== undefined) { intervals.delete(id); timeouts.delete(id); } clearInterval(id); }) as typeof window.clearInterval;
  window.requestAnimationFrame = callback => { const id = frame(time => { frames.delete(id); callback(time); }); frames.add(id); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); cancelFrame(id); };
  const resize = new Set<ResizeObserver>(), mutations = new Set<MutationObserver>();
  const Resize = window.ResizeObserver, Mutation = window.MutationObserver;
  window.ResizeObserver = class extends Resize {
    private targets = new Set<Element>();
    observe(target: Element, options?: ResizeObserverOptions) { super.observe(target, options); this.targets.add(target); resize.add(this); }
    unobserve(target: Element) { super.unobserve(target); this.targets.delete(target); if (!this.targets.size) resize.delete(this); }
    disconnect() { super.disconnect(); this.targets.clear(); resize.delete(this); }
  };
  window.MutationObserver = class extends Mutation {
    observe(target: Node, options?: MutationObserverInit) { super.observe(target, options); mutations.add(this); }
    disconnect() { super.disconnect(); mutations.delete(this); }
  };
  return {
    snapshot: () => ({ globalListeners: listeners.size, timeouts: timeouts.size, intervals: intervals.size,
      animationFrames: frames.size, resizeObservers: resize.size, mutationObservers: mutations.size }),
    // Wait using originals, keeping the measurement itself out of the counters.
    settle: (ms = 30) => new Promise<void>(resolve => timeout(resolve, ms)),
    restore() {
      restores.forEach(restore => restore());
      window.setTimeout = timeout; window.clearTimeout = clearTimeout;
      window.setInterval = interval; window.clearInterval = clearInterval;
      window.requestAnimationFrame = frame; window.cancelAnimationFrame = cancelFrame;
      window.ResizeObserver = Resize; window.MutationObserver = Mutation;
    },
  };
}
