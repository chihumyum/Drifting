class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** Install only the browser primitives touched by renderer-owned stores. */
export function installHeadlessRendererGlobals(): void {
  let storageAvailable = false;
  try {
    const probe = '__drifting_cli_storage_probe__';
    globalThis.localStorage?.setItem(probe, '1');
    storageAvailable = globalThis.localStorage?.getItem(probe) === '1';
    globalThis.localStorage?.removeItem(probe);
  } catch {
    storageAvailable = false;
  }
  if (!storageAvailable) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
    });
  }
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
    });
  }
  if (!('window' in globalThis)) {
    const listeners = new Map<string, Set<EventListener>>();
    const windowShim = {
      addEventListener(type: string, listener: EventListener) {
        const bucket = listeners.get(type) ?? new Set<EventListener>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(event: Event) {
        listeners.get(event.type)?.forEach((listener) => listener(event));
        return true;
      },
      localStorage: globalThis.localStorage,
    };
    Object.defineProperty(globalThis, 'window', { value: windowShim, configurable: true });
  }
}
