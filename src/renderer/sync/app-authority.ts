/**
 * App-wide sync provider authority.
 *
 * Drifting deliberately does not let projects select providers independently.
 * The current `mode` remains the sole authority while a target provider is
 * prepared. A transition becomes visible only after every active SyncGeneration has a
 * durable activation receipt and the caller atomically replaces provider
 * bindings together with this authority row.
 */

export const SYNC_PROVIDER_MODES = ['local', 'google-drive', 'hosted'] as const;

export type SyncProviderMode = (typeof SYNC_PROVIDER_MODES)[number];
export type CloudSyncProviderMode = Exclude<SyncProviderMode, 'local'>;

export const SYNC_APP_TRANSITION_STATES = [
  'stable',
  'connecting',
  'switching',
  'disconnecting',
  'blocked',
] as const;

export type SyncAppTransitionState = (typeof SYNC_APP_TRANSITION_STATES)[number];
type ActiveSyncAppTransitionState = Exclude<SyncAppTransitionState, 'stable' | 'blocked'>;

interface SyncAppAuthorityBase {
  id: 'app';
  /** The only provider currently allowed to publish or pull domain objects. */
  mode: SyncProviderMode;
  /** Incremented only when an all-SyncGeneration transition commits. */
  generation: number;
  updatedAt: string;
}

export interface StableSyncAppAuthority extends SyncAppAuthorityBase {
  transitionState: 'stable';
  targetMode: null;
  attemptId: null;
}

export interface TransitioningSyncAppAuthority extends SyncAppAuthorityBase {
  transitionState: ActiveSyncAppTransitionState;
  targetMode: SyncProviderMode;
  attemptId: string;
}

export interface BlockedSyncAppAuthority extends SyncAppAuthorityBase {
  transitionState: 'blocked';
  targetMode: SyncProviderMode;
  attemptId: string;
}

export type SyncAppAuthority =
  | StableSyncAppAuthority
  | TransitioningSyncAppAuthority
  | BlockedSyncAppAuthority;

export interface SyncAuthorityTransitionReadiness {
  attemptId: string;
  expectedSyncGenerationIds: readonly string[];
  readySyncGenerations: readonly {
    syncGenerationId: string;
    /** Durable local receipt for target genesis/restore/disconnect readiness. */
    receiptId: string;
  }[];
}

export interface SyncProviderAccountView {
  id: string;
  mode: CloudSyncProviderMode;
  authorityGeneration: number;
}

export interface SyncProviderBindingView {
  syncGenerationId: string;
  providerAccountId: string;
  authorityGeneration: number;
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Sync authority generation must be a positive safe integer');
  }
}

function transitionStateFor(
  source: SyncProviderMode,
  target: SyncProviderMode,
): ActiveSyncAppTransitionState {
  if (source === target) throw new Error(`Sync provider is already ${target}`);
  if (source === 'local') return 'connecting';
  if (target === 'local') return 'disconnecting';
  return 'switching';
}

/** Validate a row before exposing it as product authority. */
export function assertSyncAppAuthority(value: SyncAppAuthority): void {
  if (value.id !== 'app') throw new Error('Sync app authority must use singleton id "app"');
  if (!SYNC_PROVIDER_MODES.includes(value.mode)) throw new Error('Unknown sync provider mode');
  assertGeneration(value.generation);
  requireNonEmpty(value.updatedAt, 'updatedAt');

  if (value.transitionState === 'stable') {
    if (value.targetMode !== null || value.attemptId !== null) {
      throw new Error('Stable sync authority cannot retain a target or attempt');
    }
    return;
  }

  if (!SYNC_PROVIDER_MODES.includes(value.targetMode)) {
    throw new Error('Unknown target sync provider mode');
  }
  requireNonEmpty(value.attemptId, 'attemptId');
  const inferred = transitionStateFor(value.mode, value.targetMode);
  if (value.transitionState !== 'blocked' && value.transitionState !== inferred) {
    throw new Error(
      `Invalid sync provider transition ${value.mode} -> ${value.targetMode}: expected ${inferred}, got ${value.transitionState}`,
    );
  }
}

export function createLocalSyncAppAuthority(now: string): StableSyncAppAuthority {
  requireNonEmpty(now, 'now');
  return {
    id: 'app',
    mode: 'local',
    generation: 1,
    transitionState: 'stable',
    targetMode: null,
    attemptId: null,
    updatedAt: now,
  };
}

export function beginSyncProviderTransition(
  authority: SyncAppAuthority,
  input: { targetMode: SyncProviderMode; attemptId: string; now: string },
): TransitioningSyncAppAuthority {
  assertSyncAppAuthority(authority);
  if (authority.transitionState !== 'stable') {
    throw new Error('A sync provider transition is already in progress');
  }
  requireNonEmpty(input.attemptId, 'attemptId');
  requireNonEmpty(input.now, 'now');
  return {
    ...authority,
    transitionState: transitionStateFor(authority.mode, input.targetMode),
    targetMode: input.targetMode,
    attemptId: input.attemptId,
    updatedAt: input.now,
  };
}

export function blockSyncProviderTransition(
  authority: SyncAppAuthority,
  input: { attemptId: string; now: string },
): BlockedSyncAppAuthority {
  assertSyncAppAuthority(authority);
  if (authority.transitionState === 'stable') {
    throw new Error('There is no sync provider transition to block');
  }
  if (authority.attemptId !== input.attemptId) throw new Error('Sync transition attempt mismatch');
  requireNonEmpty(input.now, 'now');
  return { ...authority, transitionState: 'blocked', updatedAt: input.now };
}

export function resumeSyncProviderTransition(
  authority: SyncAppAuthority,
  input: { attemptId: string; now: string },
): TransitioningSyncAppAuthority {
  assertSyncAppAuthority(authority);
  if (authority.transitionState !== 'blocked') {
    throw new Error('Only a blocked sync provider transition can resume');
  }
  if (authority.attemptId !== input.attemptId) throw new Error('Sync transition attempt mismatch');
  requireNonEmpty(input.now, 'now');
  return {
    ...authority,
    transitionState: transitionStateFor(authority.mode, authority.targetMode),
    updatedAt: input.now,
  };
}

export function cancelSyncProviderTransition(
  authority: SyncAppAuthority,
  input: { attemptId: string; now: string },
): StableSyncAppAuthority {
  assertSyncAppAuthority(authority);
  if (authority.transitionState === 'stable') {
    throw new Error('There is no sync provider transition to cancel');
  }
  if (authority.attemptId !== input.attemptId) throw new Error('Sync transition attempt mismatch');
  requireNonEmpty(input.now, 'now');
  return {
    id: 'app',
    mode: authority.mode,
    generation: authority.generation,
    transitionState: 'stable',
    targetMode: null,
    attemptId: null,
    updatedAt: input.now,
  };
}

function uniqueNonEmptyIds(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    requireNonEmpty(value, label);
    if (result.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    result.add(value);
  }
  return result;
}

function assertSyncGenerationReadiness(input: SyncAuthorityTransitionReadiness): void {
  requireNonEmpty(input.attemptId, 'attemptId');
  const expected = uniqueNonEmptyIds(input.expectedSyncGenerationIds, 'expectedSyncGenerationIds');
  const ready = uniqueNonEmptyIds(
    input.readySyncGenerations.map((item) => item.syncGenerationId),
    'readySyncGenerationIds',
  );
  for (const item of input.readySyncGenerations) requireNonEmpty(item.receiptId, 'receiptId');
  if (expected.size !== ready.size || [...expected].some((syncGenerationId) => !ready.has(syncGenerationId))) {
    throw new Error('Every active SyncGeneration must be ready before the App provider can switch');
  }
}

export function completeSyncProviderTransition(
  authority: SyncAppAuthority,
  readiness: SyncAuthorityTransitionReadiness & { now: string },
): StableSyncAppAuthority {
  assertSyncAppAuthority(authority);
  if (authority.transitionState === 'stable' || authority.transitionState === 'blocked') {
    throw new Error('Sync provider transition is not ready to complete');
  }
  if (authority.attemptId !== readiness.attemptId) {
    throw new Error('Sync transition attempt mismatch');
  }
  requireNonEmpty(readiness.now, 'now');
  assertSyncGenerationReadiness(readiness);
  const generation = authority.generation + 1;
  assertGeneration(generation);
  return {
    id: 'app',
    mode: authority.targetMode,
    generation,
    transitionState: 'stable',
    targetMode: null,
    attemptId: null,
    updatedAt: readiness.now,
  };
}

/**
 * Verify the active (not staged) bindings against the single App authority.
 * Callers pass only live project SyncGenerations; terminal purge SyncGenerations remain in the
 * journal but do not require an active provider binding.
 */
export function assertUniformSyncProvider(
  authority: SyncAppAuthority,
  input: {
    activeSyncGenerationIds: readonly string[];
    providerAccount: SyncProviderAccountView | null;
    bindings: readonly SyncProviderBindingView[];
  },
): void {
  assertSyncAppAuthority(authority);
  const syncGenerationIds = uniqueNonEmptyIds(input.activeSyncGenerationIds, 'activeSyncGenerationIds');
  const bindingSyncGenerationIds = uniqueNonEmptyIds(
    input.bindings.map((binding) => binding.syncGenerationId),
    'bindingSyncGenerationIds',
  );

  if (authority.mode === 'local') {
    if (input.providerAccount !== null || input.bindings.length !== 0) {
      throw new Error('Local App authority cannot coexist with a provider account or SyncGeneration binding');
    }
    return;
  }

  const account = input.providerAccount;
  if (!account) throw new Error('Cloud App authority requires one provider account');
  if (account.mode !== authority.mode || account.authorityGeneration !== authority.generation) {
    throw new Error('Provider account does not match the App authority generation');
  }
  if (
    syncGenerationIds.size !== bindingSyncGenerationIds.size ||
    [...syncGenerationIds].some((syncGenerationId) => !bindingSyncGenerationIds.has(syncGenerationId))
  ) {
    throw new Error('Every active SyncGeneration must have exactly one binding to the App provider account');
  }
  for (const binding of input.bindings) {
    if (
      binding.providerAccountId !== account.id ||
      binding.authorityGeneration !== authority.generation
    ) {
      throw new Error('SyncGeneration binding crosses the App provider authority');
    }
  }
}
