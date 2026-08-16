import {
  createLocalObjectRef,
  type LocalObjectRef,
} from '../protocol';
import { ObjectLogProviderError, throwIfProviderAborted } from './provider-error';

/**
 * Provider-facing access to native-owned transfer objects.
 *
 * Product providers receive only opaque `LocalObjectRef` values. A real Tauri
 * implementation resolves them inside a root-confined native object store;
 * the in-memory implementation exists for deterministic conformance tests.
 */
export interface ProviderLocalObjectStore {
  read(ref: LocalObjectRef, signal: AbortSignal): Promise<Uint8Array>;
  write(ref: LocalObjectRef, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export class MemoryProviderLocalObjectStore implements ProviderLocalObjectStore {
  private readonly objects = new Map<LocalObjectRef, Uint8Array>();

  ref(token: string): LocalObjectRef {
    return createLocalObjectRef(`syncobj:memory.${token}`);
  }

  put(token: string, bytes: Uint8Array): LocalObjectRef {
    const ref = this.ref(token);
    this.objects.set(ref, cloneBytes(bytes));
    return ref;
  }

  has(ref: LocalObjectRef): boolean {
    return this.objects.has(ref);
  }

  bytes(ref: LocalObjectRef): Uint8Array | null {
    const bytes = this.objects.get(ref);
    return bytes ? cloneBytes(bytes) : null;
  }

  async read(ref: LocalObjectRef, signal: AbortSignal): Promise<Uint8Array> {
    throwIfProviderAborted(signal);
    const bytes = this.objects.get(ref);
    if (!bytes) {
      throw new ObjectLogProviderError(
        'LOCAL_OBJECT_MISSING',
        `Local transfer object ${ref} is unavailable`,
      );
    }
    return cloneBytes(bytes);
  }

  async write(ref: LocalObjectRef, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    throwIfProviderAborted(signal);
    this.objects.set(ref, cloneBytes(bytes));
  }
}
