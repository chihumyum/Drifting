import { randomUUID } from 'node:crypto';
import type { CliEnvelope } from './types';

export function cliRequestId(value?: string): string {
  const normalized = value?.trim();
  return normalized || `cli-${randomUUID()}`;
}

export function successEnvelope<T>(input: {
  command: string;
  requestId: string;
  startedAt: number;
  mode: CliEnvelope['meta']['mode'];
  data: T;
  projectId?: string;
  databasePath?: string;
  backupPath?: string;
}): CliEnvelope<T> {
  return {
    ok: true,
    command: input.command,
    requestId: input.requestId,
    data: input.data,
    meta: {
      durationMs: Date.now() - input.startedAt,
      mode: input.mode,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.databasePath ? { databasePath: input.databasePath } : {}),
      ...(input.backupPath ? { backupPath: input.backupPath } : {}),
    },
  };
}

export function failureEnvelope(input: {
  command: string;
  requestId: string;
  startedAt: number;
  mode: CliEnvelope['meta']['mode'];
  error: unknown;
  projectId?: string;
  databasePath?: string;
}): CliEnvelope {
  const error = normalizeCliError(input.error);
  return {
    ok: false,
    command: input.command,
    requestId: input.requestId,
    error,
    meta: {
      durationMs: Date.now() - input.startedAt,
      mode: input.mode,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.databasePath ? { databasePath: input.databasePath } : {}),
    },
  };
}

export function normalizeCliError(error: unknown): NonNullable<CliEnvelope['error']> {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    const code =
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? String((error as Error & { code: string }).code)
        : 'CLI_FAILED';
    return { code, message: error.message };
  }
  return { code: 'CLI_FAILED', message: String(error) };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function printEnvelope(envelope: CliEnvelope, human: boolean): void {
  if (!human) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (!envelope.ok) {
    process.stderr.write(
      `${envelope.error?.code ?? 'CLI_FAILED'}: ${envelope.error?.message ?? 'Unknown error'}\n`,
    );
    return;
  }
  if (typeof envelope.data === 'string') {
    process.stdout.write(`${envelope.data}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope.data, null, 2)}\n`);
}
