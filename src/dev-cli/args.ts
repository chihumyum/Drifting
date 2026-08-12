import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, cliRequestId } from './protocol';
import type { CliGlobalOptions, ParsedCliInput } from './types';

const VALUE_FLAGS = new Set([
  'db',
  'project',
  'base-url',
  'bridge',
  'cookie-file',
  'request-id',
  'input',
  'method',
]);
const BOOLEAN_FLAGS = new Set(['human', 'json', 'yes', 'offline-userdata', 'stream', 'help']);
const GLOBAL_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliInput {
  const command: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const values: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      command.push(token);
      continue;
    }
    const equalsAt = token.indexOf('=');
    const rawName = token.slice(2, equalsAt >= 0 ? equalsAt : undefined);
    if (!rawName) throw new CliError('INVALID_ARGUMENT', 'Empty option name');
    const inlineValue = equalsAt >= 0 ? token.slice(equalsAt + 1) : undefined;
    if (GLOBAL_FLAGS.has(rawName)) {
      if (BOOLEAN_FLAGS.has(rawName)) {
        flags[rawName] = inlineValue === undefined ? true : parseScalar(inlineValue) === true;
      } else {
        const next = inlineValue ?? argv[++index];
        if (next === undefined || next.startsWith('--'))
          throw new CliError('INVALID_ARGUMENT', `--${rawName} requires a value`);
        flags[rawName] = next;
      }
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && next !== undefined && !next.startsWith('--')) index += 1;
    const value =
      inlineValue !== undefined || (next !== undefined && !next.startsWith('--'))
        ? parseScalar(next!)
        : true;
    const key = camelCase(rawName);
    const previous = values[key];
    values[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return { command, flags, values };
}

export async function resolveInput(parsed: ParsedCliInput): Promise<Record<string, unknown>> {
  const raw = parsed.flags.input;
  if (raw === undefined) return { ...parsed.values };
  if (typeof raw !== 'string')
    throw new CliError('INVALID_ARGUMENT', '--input requires JSON or @file');
  const content = raw.startsWith('@') ? await readFile(resolve(raw.slice(1)), 'utf8') : raw;
  let object: unknown;
  try {
    object = JSON.parse(content);
  } catch (error) {
    throw new CliError(
      'INVALID_JSON',
      '--input is not valid JSON',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new CliError('INVALID_JSON', '--input must be a JSON object');
  }
  return { ...(object as Record<string, unknown>), ...parsed.values };
}

export function globalOptions(parsed: ParsedCliInput): CliGlobalOptions {
  const stringFlag = (name: string) =>
    typeof parsed.flags[name] === 'string' ? String(parsed.flags[name]) : undefined;
  return {
    output: parsed.flags.human === true ? 'human' : 'json',
    ...(stringFlag('project') ? { projectId: stringFlag('project') } : {}),
    ...(stringFlag('db') ? { databasePath: stringFlag('db') } : {}),
    ...(stringFlag('base-url') ? { baseUrl: stringFlag('base-url') } : {}),
    ...(stringFlag('bridge') ? { bridgeUrl: stringFlag('bridge') } : {}),
    ...(stringFlag('cookie-file') ? { cookieFile: stringFlag('cookie-file') } : {}),
    requestId: cliRequestId(stringFlag('request-id')),
    yes: parsed.flags.yes === true,
    offlineUserdata: parsed.flags['offline-userdata'] === true,
    stream: parsed.flags.stream === true,
  };
}
