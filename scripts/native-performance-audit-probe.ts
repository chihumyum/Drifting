// Read-only metadata for an explicitly instrumented development instance.
// No selectors, props, keys, document text or typed characters are exported.
interface Fiber {
  tag: number;
  type?: { name?: string; displayName?: string; render?: { name?: string }; type?: { name?: string } };
  actualDuration: number;
  actualStartTime: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate?: Fiber | null;
}
type Bucket = { count: number; total: number; max: number; over50: number; over100: number; over1000: number; values: number[]; dropped: number };
function bucket(): Bucket { return { count: 0, total: 0, max: 0, over50: 0, over100: 0, over1000: 0, values: [], dropped: 0 }; }
function add(b: Bucket, value: number) {
  b.count++; b.total += value; b.max = Math.max(b.max, value);
  if (value > 50) b.over50++;
  if (value > 100) b.over100++;
  if (value > 1000) b.over1000++;
  if (b.values.length < 2048) b.values.push(Math.round(value * 100) / 100);
  else b.dropped++;
}

let installed = false;
export function installNativePerformanceAudit({ endpoint, token }: { endpoint: string; token: string }) {
  if (installed) return;
  installed = true;
  const session = crypto.randomUUID();
  const startedAt = Date.now();
  let lastFrame = 0;
  let lastCommit = 0;
  let lastTick = performance.now();
  let windowStarted = performance.now();
  let frames = bucket(); let input = bucket(); let timer = bucket(); let commits = bucket();
  let observationMs = 0;
  let commitErrors = 0;
  let mutations = { attributes: 0, characterData: 0, childList: 0, added: 0, removed: 0 };
  let components = new Map<string, { renders: number; selfMs: number; maxSelfMs: number }>();
  let ipc = new Map<string, { calls: number; failures: number; durationMs: number; maxMs: number; rows: number; stringChars: number }>();
  let inFlight = 0;
  let maxInFlight = 0;
  let nativeProcesses: unknown = null;
  let processInfoRequested = false;
  let errors: string[] = [];
  let pendingInputs = 0;
  let visibilityEpoch = 0;
  document.addEventListener('visibilitychange', () => {
    visibilityEpoch++; lastFrame = 0; lastTick = performance.now();
    frames = bucket(); input = bucket(); timer = bucket();
  });
  const win = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const readProcessInfo = tauri ? tauri.invoke.bind(tauri, 'dev_watchdog_process_info') : null;
  if (tauri) {
    const originalInvoke = tauri.invoke;
    tauri.invoke = function(command, ...args) {
      const start = performance.now();
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const done = (result: unknown, failed: boolean) => {
        inFlight--;
        const elapsed = performance.now() - start;
        const item = ipc.get(command) ?? { calls: 0, failures: 0, durationMs: 0, maxMs: 0, rows: 0, stringChars: 0 };
        item.calls++; item.failures += Number(failed); item.durationMs += elapsed; item.maxMs = Math.max(item.maxMs, elapsed);
        if (Array.isArray(result)) item.rows += result.length;
        if (typeof result === 'string') item.stringChars += result.length;
        ipc.set(command, item);
      };
      try {
        return originalInvoke.call(this, command, ...args).then(result => { done(result, false); return result; }, error => { done(null, true); throw error; });
      } catch (error) { done(null, true); throw error; }
    };
  }
  // React 19 development's FiberRoot has ProfileMode enabled. Restrict work
  // to fibers whose render began since the previous commit; reused subtrees
  // otherwise retain old actualDuration values. Record observer overhead.
  if (!win.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject: () => 1,
      onCommitFiberRoot(_id: number, root: { current: Fiber }, _priority: number, didError: boolean) {
        const before = performance.now();
        add(commits, root.current.actualDuration);
        if (didError) commitErrors++;
        const stack = [root.current];
        while (stack.length) {
          const fiber = stack.pop()!;
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
          if (![0, 1, 11, 14, 15].includes(fiber.tag) || fiber.actualStartTime < lastCommit || fiber.actualDuration <= 0) continue;
          const type = fiber.type;
          const name = type?.displayName || type?.name || type?.render?.name || type?.type?.name || 'Anonymous';
          let childrenMs = 0;
          if (!fiber.alternate || fiber.alternate.child !== fiber.child) {
            for (let child = fiber.child; child; child = child.sibling) childrenMs += child.actualDuration;
          }
          const selfMs = Math.max(0, fiber.actualDuration - childrenMs);
          const item = components.get(name) ?? { renders: 0, selfMs: 0, maxSelfMs: 0 };
          item.renders++; item.selfMs += selfMs; item.maxSelfMs = Math.max(item.maxSelfMs, selfMs);
          components.set(name, item);
        }
        lastCommit = before;
        observationMs += performance.now() - before;
      },
      onCommitFiberUnmount() {},
    };
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      mutations[record.type]++;
      mutations.added += record.addedNodes.length;
      mutations.removed += record.removedNodes.length;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const frame = (now: number) => {
    if (document.visibilityState === 'visible') {
      if (lastFrame) add(frames, now - lastFrame);
      lastFrame = now;
    } else lastFrame = 0;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  for (const kind of ['pointerdown', 'keydown', 'beforeinput', 'wheel']) document.addEventListener(kind, () => {
    if (document.visibilityState !== 'visible' || pendingInputs >= 20) return;
    const start = performance.now(); const epoch = visibilityEpoch; pendingInputs++;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.visibilityState === 'visible' && epoch === visibilityEpoch) add(input, performance.now() - start);
      pendingInputs--;
    }));
  }, { passive: true, capture: true });
  const failure = (kind: string, error: unknown) => {
    const name = error instanceof Error && /^(TypeError|RangeError|ReferenceError|SyntaxError|Error)$/.test(error.name) ? error.name : 'unknown';
    if (errors.length < 10) errors.push(`${kind}:${name}`);
  };
  window.addEventListener('error', event => failure('window-error', event.error));
  window.addEventListener('unhandledrejection', event => failure('unhandled-rejection', event.reason));
  let longTasks = bucket();
  const supportedEntries = typeof PerformanceObserver === 'undefined' ? [] : PerformanceObserver.supportedEntryTypes;
  if (supportedEntries.includes('longtask')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) add(longTasks, entry.duration);
  }).observe({ entryTypes: ['longtask'] });
  let sending = false;
  setInterval(() => {
    const now = performance.now();
    if (document.visibilityState === 'visible') add(timer, Math.max(0, now - lastTick - 250));
    lastTick = now;
    if (sending || now - windowStarted < 2000) return;
    if (readProcessInfo && !processInfoRequested && (!nativeProcesses || !(nativeProcesses as { webContentPid?: number }).webContentPid)) {
      processInfoRequested = true;
      void readProcessInfo().then(info => {
        const pids = info as { nativePid?: number; webContentPid?: number } | null;
        if (pids && Number.isInteger(pids.nativePid) && Number.isInteger(pids.webContentPid)) {
          nativeProcesses = { nativePid: pids.nativePid, webContentPid: pids.webContentPid };
        }
      })
        .catch(() => {}).finally(() => { processInfoRequested = false; });
    }
    const before = performance.now();
    const data = {
      session, startedAt, at: Date.now(), startMs: windowStarted, endMs: now,
      visible: document.visibilityState === 'visible', focused: document.hasFocus(),
      frameGaps: frames, inputToTwoRaf: input, timerDelay: timer, reactCommits: commits,
      componentRenders: [...components].sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, 30).map(([name, values]) => ({ name, ...values })),
      mutations, commitErrors, errors,
      ipc: [...ipc].map(([command, stats]) => ({ command, ...stats })), inFlight, maxInFlight,
      nativeProcesses,
      dom: { elements: document.getElementsByTagName('*').length, editors: document.querySelectorAll('.ProseMirror').length, canvases: document.querySelectorAll('canvas').length, svg: document.querySelectorAll('svg').length },
      observerMs: observationMs, snapshotMs: 0,
      longTasks, supportedEntries,
    };
    data.snapshotMs = performance.now() - before;
    frames = bucket(); input = bucket(); timer = bucket(); commits = bucket(); observationMs = 0; commitErrors = 0;
    mutations = { attributes: 0, characterData: 0, childList: 0, added: 0, removed: 0 };
    components = new Map(); errors = []; longTasks = bucket(); windowStarted = now;
    ipc = new Map(); maxInFlight = inFlight;
    sending = true;
    void fetch(`${endpoint}/samples`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .catch(() => {}).finally(() => { sending = false; });
  }, 250);
}
