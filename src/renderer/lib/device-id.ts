import loglevel from 'loglevel';

const log = loglevel.getLogger('DeviceId');
log.setLevel(loglevel.levels.WARN);

const DEVICE_ID_STORAGE_KEY = 'drifting:device-id';
const LEGACY_YJS_DEVICE_ID_STORAGE_KEY = 'drifting:yjs-device-id';

let memoizedDeviceId: string | null = null;

function createDeviceId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function persistDeviceId(deviceId: string): void {
  globalThis.localStorage?.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  globalThis.localStorage?.setItem(LEGACY_YJS_DEVICE_ID_STORAGE_KEY, deviceId);
}

export function getDeviceId(): string {
  if (memoizedDeviceId) return memoizedDeviceId;

  try {
    const stored =
      globalThis.localStorage?.getItem(DEVICE_ID_STORAGE_KEY) ??
      globalThis.localStorage?.getItem(LEGACY_YJS_DEVICE_ID_STORAGE_KEY);

    if (stored) {
      memoizedDeviceId = stored;
      persistDeviceId(stored);
      return stored;
    }

    const next = createDeviceId();
    persistDeviceId(next);
    memoizedDeviceId = next;
    return next;
  } catch (error) {
    log.warn('[device-id] failed to persist device id:', error);
    memoizedDeviceId = createDeviceId();
    return memoizedDeviceId;
  }
}
