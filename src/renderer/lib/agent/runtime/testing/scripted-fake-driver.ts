import {
  abortReason,
  AgentRuntimeAbortError,
  throwIfAgentAborted,
} from '../errors';
import type {
  AgentClock,
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStreamEvent,
  AgentReasoningOptions,
} from '../types';

export interface AgentToolDefinitionSnapshot {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface AgentModelRequestSnapshot {
  readonly sessionId: string;
  readonly turnId: string;
  readonly iteration: number;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly reasoning?: AgentReasoningOptions;
  readonly messages: readonly AgentModelMessage[];
  readonly tools: readonly AgentToolDefinitionSnapshot[];
  readonly maxOutputTokens: number;
  readonly signalAborted: boolean;
}

export interface ScriptedRequestExpectation {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly iteration?: number;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly reasoning?: AgentReasoningOptions;
  readonly messages?: readonly AgentModelMessage[];
  readonly tools?: readonly AgentToolDefinitionSnapshot[];
  readonly toolNames?: readonly string[];
  readonly maxOutputTokens?: number;
  readonly signalAborted?: boolean;
}

export type ScriptedRequestAssertion = (
  request: AgentModelRequestSnapshot,
  roundIndex: number,
) => void;

export type ScriptedDriverStep =
  | { readonly op: 'emit'; readonly event: AgentModelStreamEvent }
  | { readonly op: 'sleep'; readonly ms: number }
  | { readonly op: 'wait'; readonly gate: string }
  | {
      readonly op: 'throw';
      readonly error: Error | string | { readonly name?: string; readonly message: string };
    };

export interface ScriptedDriverRound {
  readonly name?: string;
  readonly expectRequest?: ScriptedRequestExpectation | ScriptedRequestAssertion;
  readonly steps: readonly ScriptedDriverStep[];
}

export interface ScriptedFakeDriverOptions {
  readonly id?: string;
  readonly rounds: readonly ScriptedDriverRound[];
  /** Required only by rounds containing an `op: "sleep"` step. */
  readonly clock?: Pick<AgentClock, 'sleep'>;
}

type RoundStatus = 'pending' | 'active' | 'completed' | 'abandoned';

interface RoundState {
  readonly script: ScriptedDriverRound;
  status: RoundStatus;
  nextStepIndex: number;
}

interface AbortableWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ReachWaiter extends AbortableWaiter {
  readonly occurrence: number;
}

interface GateState {
  reached: number;
  releaseCredits: number;
  releaseWaiters: AbortableWaiter[];
  reachWaiters: ReachWaiter[];
}

export class ScriptedFakeDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptedFakeDriverError';
  }
}

export class ScriptedRequestMismatchError extends ScriptedFakeDriverError {
  constructor(
    public readonly roundIndex: number,
    public readonly field: string,
    public readonly expected: unknown,
    public readonly actual: unknown,
  ) {
    super(
      `Scripted driver round ${roundIndex + 1} request mismatch at ${field}: `
      + `expected ${formatValue(expected)}, received ${formatValue(actual)}`,
    );
    this.name = 'ScriptedRequestMismatchError';
  }
}

function cloneData<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as object;
  const existing = seen.get(objectValue);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(objectValue, result);
    for (const item of value) result.push(cloneData(item, seen));
    return result as T;
  }

  const result: Record<string, unknown> = {};
  seen.set(objectValue, result);
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneData(item, seen);
  }
  return result as T;
}

function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const item of Object.values(value)) freezeData(item, seen);
  return Object.freeze(value);
}

function snapshotRequest(request: AgentModelRequest): AgentModelRequestSnapshot {
  const snapshot: AgentModelRequestSnapshot = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    iteration: request.iteration,
    ...(request.model ? { model: request.model } : {}),
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.reasoning ? { reasoning: cloneData(request.reasoning) } : {}),
    messages: cloneData(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: cloneData(tool.inputSchema),
    })),
    maxOutputTokens: request.maxOutputTokens,
    signalAborted: request.signal.aborted,
  };
  return freezeData(snapshot);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (!deepEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function materializeError(
  error: Error | string | { readonly name?: string; readonly message: string },
): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  const result = new Error(error.message);
  if (error.name) result.name = error.name;
  return result;
}

function requireGateName(gate: string): string {
  if (gate.trim().length === 0) {
    throw new ScriptedFakeDriverError('Gate name must not be empty');
  }
  return gate;
}

/**
 * Provider-only fake. It records normalized requests and emits a fixed model
 * stream; it never executes tools or touches renderer/Tauri state.
 */
export class ScriptedFakeDriver implements AgentModelDriver {
  readonly id: string;

  private readonly clock?: Pick<AgentClock, 'sleep'>;
  private readonly rounds: RoundState[];
  private readonly requestSnapshots: AgentModelRequestSnapshot[] = [];
  private readonly gates = new Map<string, GateState>();
  private nextRoundIndex = 0;
  private fatalError: ScriptedFakeDriverError | null = null;

  constructor(options: ScriptedFakeDriverOptions) {
    this.id = options.id ?? 'scripted-fake';
    this.clock = options.clock;
    this.rounds = options.rounds.map((script) => ({
      script: { ...script, steps: [...script.steps] },
      status: 'pending',
      nextStepIndex: 0,
    }));
  }

  get calls(): readonly AgentModelRequestSnapshot[] {
    return [...this.requestSnapshots];
  }

  stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    const snapshot = snapshotRequest(request);
    this.requestSnapshots.push(snapshot);
    throwIfAgentAborted(request.signal);

    if (this.fatalError) throw this.fatalError;
    const roundIndex = this.nextRoundIndex;
    const round = this.rounds[roundIndex];
    if (!round) {
      const error = new ScriptedFakeDriverError(
        `Unexpected model request ${roundIndex + 1}; only ${this.rounds.length} round(s) scripted`,
      );
      this.fatalError = error;
      throw error;
    }

    try {
      this.assertRequest(round.script.expectRequest, snapshot, roundIndex);
    } catch (error) {
      const scriptedError =
        error instanceof ScriptedFakeDriverError
          ? error
          : new ScriptedFakeDriverError(
              `Scripted driver round ${roundIndex + 1} request assertion failed: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
      this.fatalError = scriptedError;
      throw scriptedError;
    }

    this.nextRoundIndex += 1;
    round.status = 'active';
    return this.playRound(round, request.signal);
  }

  /**
   * Resolves once the named gate has been reached the requested number of
   * times. This observes a gate; only `release` lets the stream continue.
   */
  waitUntilGate(
    gate: string,
    occurrence = 1,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = requireGateName(gate);
    if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
      throw new RangeError(`occurrence must be a positive safe integer; received ${occurrence}`);
    }
    if (signal?.aborted) {
      return Promise.reject(new AgentRuntimeAbortError(abortReason(signal)));
    }

    const state = this.getGate(name);
    if (state.reached >= occurrence) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const waiter: ReachWaiter = {
        occurrence,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        const onAbort = () => {
          if (!this.removeWaiter(state.reachWaiters, waiter)) return;
          signal.removeEventListener('abort', onAbort);
          reject(new AgentRuntimeAbortError(abortReason(signal)));
        };
        Object.assign(waiter, { onAbort });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.reachWaiters.push(waiter);
    });
  }

  /**
   * Release one or more waits. Calling this before a gate is reached creates
   * deterministic release credits, which is useful when test actors race.
   */
  release(gate: string, count = 1): void {
    const state = this.getGate(requireGateName(gate));
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError(`release count must be a positive safe integer; received ${count}`);
    }

    for (let index = 0; index < count; index += 1) {
      const waiter = state.releaseWaiters.shift();
      if (!waiter) {
        state.releaseCredits += 1;
        continue;
      }
      this.detachAbort(waiter);
      waiter.resolve();
    }
  }

  assertExhausted(): void {
    if (this.fatalError) throw this.fatalError;

    const problems: string[] = [];
    for (let index = 0; index < this.rounds.length; index += 1) {
      const round = this.rounds[index];
      if (round.status === 'completed') continue;
      const name = round.script.name ? ` (${round.script.name})` : '';
      const remaining = round.script.steps.length - round.nextStepIndex;
      problems.push(
        `round ${index + 1}${name}: ${round.status}, ${remaining} unconsumed step(s)`,
      );
    }

    if (problems.length > 0) {
      throw new ScriptedFakeDriverError(
        `Scripted driver was not exhausted:\n${problems.join('\n')}`,
      );
    }
  }

  private async *playRound(
    round: RoundState,
    signal: AbortSignal,
  ): AsyncGenerator<AgentModelStreamEvent> {
    try {
      while (round.nextStepIndex < round.script.steps.length) {
        throwIfAgentAborted(signal);
        const step = round.script.steps[round.nextStepIndex];
        round.nextStepIndex += 1;

        switch (step.op) {
          case 'emit':
            yield cloneData(step.event);
            throwIfAgentAborted(signal);
            break;

          case 'sleep':
            if (!this.clock) {
              throw new ScriptedFakeDriverError(
                'A ScriptedFakeDriver clock is required for an op: "sleep" step',
              );
            }
            await this.clock.sleep(step.ms, signal);
            throwIfAgentAborted(signal);
            break;

          case 'wait':
            await this.waitForRelease(step.gate, signal);
            throwIfAgentAborted(signal);
            break;

          case 'throw':
            throw materializeError(step.error);
        }
      }
    } finally {
      round.status =
        round.nextStepIndex === round.script.steps.length ? 'completed' : 'abandoned';
    }
  }

  private assertRequest(
    expectation: ScriptedDriverRound['expectRequest'],
    actual: AgentModelRequestSnapshot,
    roundIndex: number,
  ): void {
    if (!expectation) return;
    if (typeof expectation === 'function') {
      expectation(actual, roundIndex);
      return;
    }

    const fields: Array<keyof Omit<ScriptedRequestExpectation, 'toolNames'>> = [
      'sessionId',
      'turnId',
      'iteration',
      'model',
      'systemPrompt',
      'reasoning',
      'messages',
      'tools',
      'maxOutputTokens',
      'signalAborted',
    ];
    for (const field of fields) {
      const expected = expectation[field];
      if (expected !== undefined && !deepEqual(expected, actual[field])) {
        throw new ScriptedRequestMismatchError(roundIndex, field, expected, actual[field]);
      }
    }

    if (expectation.toolNames) {
      const actualToolNames = actual.tools.map((tool) => tool.name);
      if (!deepEqual(expectation.toolNames, actualToolNames)) {
        throw new ScriptedRequestMismatchError(
          roundIndex,
          'toolNames',
          expectation.toolNames,
          actualToolNames,
        );
      }
    }
  }

  private async waitForRelease(gate: string, signal: AbortSignal): Promise<void> {
    const state = this.getGate(requireGateName(gate));
    state.reached += 1;
    this.resolveReachWaiters(state);

    if (state.releaseCredits > 0) {
      state.releaseCredits -= 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: AbortableWaiter = { resolve, reject, signal };
      const onAbort = () => {
        if (!this.removeWaiter(state.releaseWaiters, waiter)) return;
        signal.removeEventListener('abort', onAbort);
        reject(new AgentRuntimeAbortError(abortReason(signal)));
      };
      Object.assign(waiter, { onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      state.releaseWaiters.push(waiter);
    });
  }

  private resolveReachWaiters(state: GateState): void {
    const remaining: ReachWaiter[] = [];
    for (const waiter of state.reachWaiters) {
      if (waiter.occurrence > state.reached) {
        remaining.push(waiter);
        continue;
      }
      this.detachAbort(waiter);
      waiter.resolve();
    }
    state.reachWaiters = remaining;
  }

  private getGate(name: string): GateState {
    let state = this.gates.get(name);
    if (!state) {
      state = {
        reached: 0,
        releaseCredits: 0,
        releaseWaiters: [],
        reachWaiters: [],
      };
      this.gates.set(name, state);
    }
    return state;
  }

  private removeWaiter<T extends AbortableWaiter>(waiters: T[], target: T): boolean {
    const index = waiters.indexOf(target);
    if (index < 0) return false;
    waiters.splice(index, 1);
    return true;
  }

  private detachAbort(waiter: AbortableWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
