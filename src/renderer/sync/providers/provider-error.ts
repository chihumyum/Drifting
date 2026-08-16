export type ObjectLogProviderErrorCode =
  | 'ABORTED'
  | 'INVALID_CURSOR'
  | 'INVALID_PAGE_TOKEN'
  | 'INVALID_GENERATION'
  | 'LOCAL_OBJECT_MISSING'
  | 'REMOTE_OBJECT_MISSING'
  | 'IMMUTABLE_OBJECT_CONFLICT'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'REMOTE_STORE_CORRUPT';

export class ObjectLogProviderError extends Error {
  readonly code: ObjectLogProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ObjectLogProviderErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ObjectLogProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function throwIfProviderAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ObjectLogProviderError('ABORTED', 'Object-log provider operation was cancelled');
  }
}
