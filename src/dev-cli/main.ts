#!/usr/bin/env node

import { parseCliArgs, globalOptions, resolveInput } from './args';
import { installHeadlessRendererGlobals } from './headless-globals';
import { DEV_CLI_MODEL_CAPABILITIES, DEV_CLI_PROVIDER_TOOLS } from './manifest';
import type { OfflineProductDatabase } from './offline-database';
import { bridgeRequest, serverRequest } from './http-client';
import { CliError, failureEnvelope, printEnvelope, successEnvelope } from './protocol';
import { executeResourceOperation } from './resource-store';
import { prepareOfflineMutation, resolveDatabaseTarget } from './safety';
import { loadScenario, runScenario, scenarioMutates } from './scenario';

const HELP = `Drifting developer CLI

Usage:
  pnpm drifting capabilities [--model <name>]
  pnpm drifting workspace describe [tool] --project <id> --db <file>
  pnpm drifting workspace call <tool> --project <id> --db <file> [--input <json|@file>]
  pnpm drifting workspace resource <operation> <model> --project <id> --db <file>
  pnpm drifting ops inspect --db <file> [--project <id>]
  pnpm drifting scenario run <file> --project <id> --db <file>
  pnpm drifting agent turn --project <id> --bridge http://127.0.0.1:4317 --prompt <text>
  pnpm drifting agent review --project <id> --bridge http://127.0.0.1:4317 --review-id <id> --decision accept|reject
  pnpm drifting frontend serve --platform android|ios [--device <id>]
  pnpm drifting frontend status|snapshot|query|wait|style|hit-test [--input <json|@file>]
  pnpm drifting frontend tap|type|scroll|drag|pinch|evaluate [--input <json|@file>]
  pnpm drifting frontend console|network [--stream]
  pnpm drifting frontend screenshot|bundle|capabilities
  pnpm drifting server request <METHOD> <path> --base-url <url> [--cookie-file <file>] [--input <json|@file>]

Output is one JSON envelope by default. Use --human for formatted data.
Every offline mutation requires --offline-userdata --yes, an exclusive database, and creates cli-backups/*.db first.`;

function commandName(parts: readonly string[]): string {
  return parts.join(' ');
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CliError('INVALID_ARGUMENT', `${name} is required`);
  return value.trim();
}

async function withOfflineDatabase<T>(input: {
  path: string;
  migrate: boolean;
  work: (database: OfflineProductDatabase) => Promise<T>;
}): Promise<T> {
  const { OfflineProductDatabase } = await import('./offline-database');
  const database = new OfflineProductDatabase(input.path, { migrate: input.migrate });
  try {
    await database.open();
    return await input.work(database);
  } finally {
    await database.close();
  }
}

async function run(argv: readonly string[]): Promise<{
  envelope: ReturnType<typeof successEnvelope> | ReturnType<typeof failureEnvelope>;
  human: boolean;
  exitCode: number;
}> {
  const startedAt = Date.now();
  const parsed = parseCliArgs(argv);
  const options = globalOptions(parsed);
  const command = commandName(parsed.command);
  let mode: 'offline' | 'bridge' | 'server' | 'local' = 'local';
  try {
    if (parsed.command.length === 0 || parsed.flags.help === true || parsed.command[0] === 'help') {
      return {
        envelope: successEnvelope({
          command: command || 'help',
          requestId: options.requestId,
          startedAt,
          mode,
          data: HELP,
        }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    const input = await resolveInput(parsed);
    if (parsed.command[0] === 'frontend') {
      const { executeFrontendCliCommand } = await import('./frontend-debug/client');
      mode = 'bridge';
      const data = await executeFrontendCliCommand({
        action: parsed.command[1],
        values: input,
        requestId: options.requestId,
        stream: options.stream,
      });
      return {
        envelope: successEnvelope({
          command,
          requestId: options.requestId,
          startedAt,
          mode,
          data,
          ...(options.projectId ? { projectId: options.projectId } : {}),
        }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    if (parsed.command[0] === 'capabilities') {
      const model = typeof input.model === 'string' ? input.model : undefined;
      const models = model
        ? DEV_CLI_MODEL_CAPABILITIES.filter((item) => item.name === model)
        : DEV_CLI_MODEL_CAPABILITIES;
      if (model && models.length === 0)
        throw new CliError('MODEL_NOT_FOUND', `Unknown model: ${model}`);
      return {
        envelope: successEnvelope({
          command,
          requestId: options.requestId,
          startedAt,
          mode,
          data: { schemaVersion: 1, models, providerTools: DEV_CLI_PROVIDER_TOOLS },
        }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    if (parsed.command[0] === 'workspace') {
      mode = 'offline';
      const projectId = requiredString(options.projectId, '--project');
      const target = await resolveDatabaseTarget(options.databasePath, options.offlineUserdata);
      if (parsed.command[1] === 'describe') {
        installHeadlessRendererGlobals();
        const toolName = parsed.command[2];
        const data = await withOfflineDatabase({
          path: target.path,
          migrate: false,
          work: async (database) => {
            const { describeOfflineWorkspaceTools } = await import('./offline-workspace');
            return describeOfflineWorkspaceTools(database.client, projectId, toolName);
          },
        });
        return {
          envelope: successEnvelope({
            command,
            requestId: options.requestId,
            startedAt,
            mode,
            data,
            projectId,
            databasePath: target.path,
          }),
          human: options.output === 'human',
          exitCode: 0,
        };
      }
      if (parsed.command[1] === 'call') {
        const toolName = requiredString(parsed.command[2], 'workspace tool name');
        const isWrite = (DEV_CLI_PROVIDER_TOOLS.write as readonly string[]).includes(toolName);
        const backupPath = isWrite
          ? await prepareOfflineMutation({
              target,
              offlineUserdata: options.offlineUserdata,
              yes: options.yes,
              requestId: options.requestId,
            })
          : undefined;
        installHeadlessRendererGlobals();
        const data = await withOfflineDatabase({
          path: target.path,
          migrate: isWrite,
          work: async (database) => {
            const { executeOfflineWorkspaceTool } = await import('./offline-workspace');
            const result = await executeOfflineWorkspaceTool({
              database: database.client,
              projectId,
              toolName,
              arguments: input,
              requestId: options.requestId,
            });
            if (!result.result.ok)
              throw new CliError('WORKSPACE_TOOL_FAILED', result.result.error, result.result);
            return result;
          },
        });
        return {
          envelope: successEnvelope({
            command,
            requestId: options.requestId,
            startedAt,
            mode,
            data,
            projectId,
            databasePath: target.path,
            ...(backupPath ? { backupPath } : {}),
          }),
          human: options.output === 'human',
          exitCode: 0,
        };
      }
      if (parsed.command[1] === 'resource') {
        const first = requiredString(parsed.command[2], 'resource operation');
        const operations = new Set(['list', 'get', 'create', 'update', 'delete']);
        const operation = operations.has(first)
          ? first
          : requiredString(parsed.command[3], 'resource operation');
        const model = operations.has(first)
          ? requiredString(parsed.command[3], 'resource model')
          : first;
        const isWrite = ['create', 'update', 'delete'].includes(operation);
        const backupPath = isWrite
          ? await prepareOfflineMutation({
              target,
              offlineUserdata: options.offlineUserdata,
              yes: options.yes,
              requestId: options.requestId,
            })
          : undefined;
        const data = await withOfflineDatabase({
          path: target.path,
          migrate: isWrite,
          work: async (database) =>
            executeResourceOperation({
              database: database.gateway.database,
              model,
              operation: operation as 'list' | 'get' | 'create' | 'update' | 'delete',
              projectId,
              values: input,
            }),
        });
        return {
          envelope: successEnvelope({
            command,
            requestId: options.requestId,
            startedAt,
            mode,
            data,
            projectId,
            databasePath: target.path,
            ...(backupPath ? { backupPath } : {}),
          }),
          human: options.output === 'human',
          exitCode: 0,
        };
      }
      throw new CliError('UNKNOWN_COMMAND', `Unknown workspace command: ${command}`);
    }
    if (parsed.command[0] === 'ops' && parsed.command[1] === 'inspect') {
      mode = 'offline';
      const target = await resolveDatabaseTarget(options.databasePath, options.offlineUserdata);
      installHeadlessRendererGlobals();
      const data = await withOfflineDatabase({
        path: target.path,
        migrate: false,
        work: async (database) => {
          const { inspectWorkspaceDatabase } = await import('./offline-workspace');
          return inspectWorkspaceDatabase(
            database.client,
            database.gateway.database,
            options.projectId,
          );
        },
      });
      return {
        envelope: successEnvelope({
          command,
          requestId: options.requestId,
          startedAt,
          mode,
          data,
          databasePath: target.path,
          ...(options.projectId ? { projectId: options.projectId } : {}),
        }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    if (parsed.command[0] === 'scenario' && parsed.command[1] === 'run') {
      mode = 'offline';
      const file = requiredString(parsed.command[2], 'scenario file');
      const projectId = requiredString(options.projectId, '--project');
      const document = await loadScenario(file);
      const target = await resolveDatabaseTarget(options.databasePath, options.offlineUserdata);
      const mutates = scenarioMutates(document);
      const backupPath = mutates
        ? await prepareOfflineMutation({
            target,
            offlineUserdata: options.offlineUserdata,
            yes: options.yes,
            requestId: options.requestId,
          })
        : undefined;
      installHeadlessRendererGlobals();
      const data = await withOfflineDatabase({
        path: target.path,
        migrate: mutates,
        work: (database) =>
          runScenario({ document, database, projectId, requestId: options.requestId }),
      });
      return {
        envelope: successEnvelope({
          command,
          requestId: options.requestId,
          startedAt,
          mode,
          data,
          projectId,
          databasePath: target.path,
          ...(backupPath ? { backupPath } : {}),
        }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    if (parsed.command[0] === 'agent') {
      mode = 'bridge';
      const bridgeUrl = requiredString(options.bridgeUrl, '--bridge');
      const projectId = requiredString(options.projectId, '--project');
      if (parsed.command[1] === 'turn') {
        const prompt = requiredString(input.prompt, '--prompt');
        const data = await bridgeRequest({
          bridgeUrl,
          endpoint: '/turn',
          body: {
            projectId,
            prompt,
            newConversation: input.newConversation !== false,
            permissionMode: input.permissionMode ?? (options.yes ? 'allow_once' : 'manual'),
            autoContinue: input.autoContinue === true,
            ...(typeof input.conversationId === 'string'
              ? { conversationId: input.conversationId }
              : {}),
            ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
            ...(typeof input.editMode === 'string' ? { editMode: input.editMode } : {}),
            ...(typeof input.thinking === 'string' ? { thinking: input.thinking } : {}),
            ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
          },
        });
        return {
          envelope: successEnvelope({
            command,
            requestId: options.requestId,
            startedAt,
            mode,
            data,
            projectId,
          }),
          human: options.output === 'human',
          exitCode: 0,
        };
      }
      if (parsed.command[1] === 'review') {
        const reviewId = requiredString(input.reviewId, '--review-id');
        const decision = requiredString(input.decision, '--decision');
        if (!['accept', 'reject'].includes(decision))
          throw new CliError('INVALID_ARGUMENT', '--decision must be accept or reject');
        const data = await bridgeRequest({
          bridgeUrl,
          endpoint: '/review',
          body: {
            projectId,
            reviewId,
            decision,
            ...(typeof input.blockId === 'string' ? { blockId: input.blockId } : {}),
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
          },
        });
        return {
          envelope: successEnvelope({
            command,
            requestId: options.requestId,
            startedAt,
            mode,
            data,
            projectId,
          }),
          human: options.output === 'human',
          exitCode: 0,
        };
      }
      throw new CliError('UNKNOWN_COMMAND', `Unknown agent command: ${command}`);
    }
    if (parsed.command[0] === 'server' && parsed.command[1] === 'request') {
      mode = 'server';
      const method = requiredString(
        parsed.command[2] ?? parsed.flags.method,
        'HTTP method',
      ).toUpperCase();
      const path = requiredString(parsed.command[3], 'request path');
      if (method === 'DELETE' && !options.yes)
        throw new CliError('DESTRUCTIVE_CONFIRMATION_REQUIRED', 'DELETE requires --yes');
      const data = await serverRequest({
        baseUrl: requiredString(options.baseUrl, '--base-url'),
        method,
        path,
        ...(Object.keys(input).length ? { body: input } : {}),
        ...(options.cookieFile ? { cookieFile: options.cookieFile } : {}),
        requestId: options.requestId,
      });
      return {
        envelope: successEnvelope({ command, requestId: options.requestId, startedAt, mode, data }),
        human: options.output === 'human',
        exitCode: 0,
      };
    }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  } catch (error) {
    return {
      envelope: failureEnvelope({
        command: command || 'unknown',
        requestId: options.requestId,
        startedAt,
        mode,
        error,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.databasePath ? { databasePath: options.databasePath } : {}),
      }),
      human: options.output === 'human',
      exitCode: 1,
    };
  }
}

void run(process.argv.slice(2)).then(
  (outcome) => {
    printEnvelope(outcome.envelope, outcome.human);
    process.exitCode = outcome.exitCode;
  },
  (error) => {
    const envelope = failureEnvelope({
      command: 'startup',
      requestId: 'cli-startup',
      startedAt: Date.now(),
      mode: 'local',
      error,
    });
    printEnvelope(envelope, false);
    process.exitCode = 1;
  },
);
