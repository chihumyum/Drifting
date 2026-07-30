import type {
  AgentPendingControl,
  AgentPermissionRequest,
  AgentPermissionResolutionInput,
  AgentSteeringInput,
  AgentStopAfterToolInput,
  AgentUserInputRequest,
  AgentUserInputResponseInput,
} from '../protocol';

export class AgentRuntimeControlError extends Error {
  constructor(
    readonly code:
      | 'AGENT_CONTROL_NOT_ACTIVE'
      | 'AGENT_CONTROL_CONFLICT'
      | 'AGENT_CONTROL_STALE'
      | 'AGENT_CONTROL_INVALID',
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AgentRuntimeControlError';
  }
}

export interface AgentRuntimeControlCallbacks {
  onSteering(input: AgentSteeringInput): Promise<void>;
  onStopAfterTool(input: AgentStopAfterToolInput): Promise<void>;
  onCancellation(reason: string): Promise<void>;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  resolve: (resolution: AgentPermissionResolutionInput) => void;
  reject: (error: unknown) => void;
  acknowledged: Promise<void>;
  acknowledge: () => void;
}

interface PendingUserInput {
  request: AgentUserInputRequest;
  resolve: (response: AgentUserInputResponseInput) => void;
  reject: (error: unknown) => void;
  acknowledged: Promise<void>;
  acknowledge: () => void;
}

/**
 * Turn-scoped synchronization primitive shared by the runtime and renderer
 * transport. It owns no policy and performs no mutation; it only makes
 * provenance-bound control commands race-free.
 */
export class AgentRuntimeControlChannel {
  private callbacks: AgentRuntimeControlCallbacks | null = null;
  private pendingPermission: PendingPermission | null = null;
  private pendingUserInput: PendingUserInput | null = null;
  private closedError: unknown = null;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
  ) {}

  attach(callbacks: AgentRuntimeControlCallbacks): () => void {
    if (this.callbacks) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_CONFLICT',
        'The Agent turn already has an attached control owner.',
      );
    }
    if (this.closedError) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'The Agent turn control channel is already closed.',
      );
    }
    this.callbacks = callbacks;
    return () => {
      if (this.callbacks === callbacks) this.callbacks = null;
    };
  }

  async steer(input: AgentSteeringInput): Promise<void> {
    this.assertTurn(input.turnId);
    if (!input.text.trim()) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_INVALID',
        'A steering message cannot be empty.',
      );
    }
    await this.requireCallbacks().onSteering(input);
  }

  async stopAfterTool(input: AgentStopAfterToolInput): Promise<void> {
    this.assertTurn(input.turnId);
    await this.requireCallbacks().onStopAfterTool(input);
  }

  async requestCancellation(reason: string): Promise<void> {
    await this.requireCallbacks().onCancellation(
      reason.trim() || 'Agent turn cancelled by user',
    );
  }

  async waitForPermission(
    request: AgentPermissionRequest,
    signal: AbortSignal,
  ): Promise<AgentPermissionResolutionInput> {
    this.assertRequestBinding(request);
    if (this.pendingPermission || this.pendingUserInput) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_CONFLICT',
        'The Agent turn is already waiting for user control.',
      );
    }
    const deferred = createDeferred<AgentPermissionResolutionInput>();
    const acknowledged = createDeferred<void>();
    const pending: PendingPermission = {
      request,
      resolve: deferred.resolve,
      reject: deferred.reject,
      acknowledged: acknowledged.promise,
      acknowledge: () => acknowledged.resolve(undefined),
    };
    this.pendingPermission = pending;
    const detach = rejectOnAbort(signal, (error) => pending.reject(error));
    try {
      return await deferred.promise;
    } finally {
      detach();
    }
  }

  async resolvePermission(
    resolution: AgentPermissionResolutionInput,
  ): Promise<void> {
    const pending = this.pendingPermission;
    if (!pending) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'The Agent turn is not waiting for permission.',
      );
    }
    if (
      resolution.requestId !== pending.request.requestId ||
      resolution.sessionId !== pending.request.sessionId ||
      resolution.turnId !== pending.request.turnId ||
      resolution.callId !== pending.request.callId ||
      resolution.argumentsHash !== pending.request.argumentsHash ||
      resolution.revision !== pending.request.revision ||
      !pending.request.allowedScopes.includes(resolution.scope)
    ) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_STALE',
        'The permission response does not match the pending tool request.',
      );
    }
    pending.resolve(resolution);
    await pending.acknowledged;
  }

  acknowledgePermission(requestId: string): void {
    const pending = this.pendingPermission;
    if (!pending || pending.request.requestId !== requestId) return;
    this.pendingPermission = null;
    pending.acknowledge();
  }

  async waitForUserInput(
    request: AgentUserInputRequest,
    signal: AbortSignal,
  ): Promise<AgentUserInputResponseInput> {
    this.assertRequestBinding(request);
    if (this.pendingPermission || this.pendingUserInput) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_CONFLICT',
        'The Agent turn is already waiting for user control.',
      );
    }
    const deferred = createDeferred<AgentUserInputResponseInput>();
    const acknowledged = createDeferred<void>();
    const pending: PendingUserInput = {
      request,
      resolve: deferred.resolve,
      reject: deferred.reject,
      acknowledged: acknowledged.promise,
      acknowledge: () => acknowledged.resolve(undefined),
    };
    this.pendingUserInput = pending;
    const detach = rejectOnAbort(signal, (error) => pending.reject(error));
    try {
      return await deferred.promise;
    } finally {
      detach();
    }
  }

  async submitUserInput(response: AgentUserInputResponseInput): Promise<void> {
    const pending = this.pendingUserInput;
    if (!pending) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'The Agent turn is not waiting for user input.',
      );
    }
    if (
      response.requestId !== pending.request.requestId ||
      response.sessionId !== pending.request.sessionId ||
      response.turnId !== pending.request.turnId ||
      response.callId !== pending.request.callId
    ) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_STALE',
        'The user response does not match the pending Agent request.',
      );
    }
    pending.resolve(response);
    await pending.acknowledged;
  }

  acknowledgeUserInput(requestId: string): void {
    const pending = this.pendingUserInput;
    if (!pending || pending.request.requestId !== requestId) return;
    this.pendingUserInput = null;
    pending.acknowledge();
  }

  close(error: unknown = new Error('Agent turn control channel closed.')): void {
    this.closedError = error;
    this.callbacks = null;
    this.pendingPermission?.reject(error);
    this.pendingPermission?.acknowledge();
    this.pendingPermission = null;
    this.pendingUserInput?.reject(error);
    this.pendingUserInput?.acknowledge();
    this.pendingUserInput = null;
  }

  pendingControl(): AgentPendingControl | null {
    if (this.pendingPermission) {
      return {
        sessionId: this.sessionId,
        turnId: this.turnId,
        status: 'waiting_permission',
        permissionRequest: this.pendingPermission.request,
        requiresContinuation: false,
      };
    }
    if (this.pendingUserInput) {
      return {
        sessionId: this.sessionId,
        turnId: this.turnId,
        status: 'waiting_user',
        userInputRequest: this.pendingUserInput.request,
        requiresContinuation: false,
      };
    }
    return null;
  }

  private requireCallbacks(): AgentRuntimeControlCallbacks {
    if (!this.callbacks || this.closedError) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_NOT_ACTIVE',
        'There is no active Agent turn for this control command.',
      );
    }
    return this.callbacks;
  }

  private assertTurn(turnId: string): void {
    if (!turnId || turnId !== this.turnId) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_STALE',
        'The control command belongs to a different Agent turn.',
      );
    }
  }

  private assertRequestBinding(
    request: Pick<AgentPermissionRequest | AgentUserInputRequest, 'sessionId' | 'turnId'>,
  ): void {
    if (
      request.sessionId !== this.sessionId ||
      request.turnId !== this.turnId
    ) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_STALE',
        'The control request belongs to a different Agent turn.',
      );
    }
  }
}

export async function hashAgentPermissionArguments(
  value: Record<string, unknown>,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AgentRuntimeControlError(
      'AGENT_CONTROL_INVALID',
      'SHA-256 is unavailable; permission provenance cannot be bound.',
    );
  }
  const canonical = canonicalControlJson(value);
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function canonicalControlJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentRuntimeControlError(
        'AGENT_CONTROL_INVALID',
        'Permission arguments contain a non-finite number.',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalControlJson).join(',')}]`;
  }
  if (typeof value !== 'object' || value === null) {
    throw new AgentRuntimeControlError(
      'AGENT_CONTROL_INVALID',
      'Permission arguments are not portable JSON.',
    );
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalControlJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectOnAbort(
  signal: AbortSignal,
  reject: (error: unknown) => void,
): () => void {
  const onAbort = () => reject(signal.reason ?? new Error('Agent turn aborted.'));
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
