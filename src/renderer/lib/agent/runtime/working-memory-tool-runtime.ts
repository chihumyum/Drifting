import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  AgentWorkingMemoryConflictError,
  type AgentWorkingMemorySnapshot,
} from '../../../domain/agent-working-memory';
import {
  loadAgentWorkingMemory,
  saveAgentWorkingMemory,
  saveAgentWorkingMemoryInDatabase,
} from '../../../usecase/useAgentWorkingMemory';
import type { DbClient } from '../../../lib/db';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolPermissionPolicy,
  AgentToolRuntime,
} from './types';
import {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';

export {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';

const readSchema = Type.Object({}, { additionalProperties: false });
const checkpointSchema = Type.Object(
  {
    operation: Type.Union([Type.Literal('update'), Type.Literal('noop')]),
    expectedRevision: Type.Integer({ minimum: 0 }),
    contentMd: Type.Optional(Type.String({ maxLength: 64_000 })),
  },
  { additionalProperties: false },
);

function validate(schema: typeof readSchema | typeof checkpointSchema, value: unknown) {
  return Value.Check(schema, value)
    ? { ok: true as const, value: value as Record<string, unknown> }
    : {
        ok: false as const,
        error: [...Value.Errors(schema, value)][0]?.message ?? 'Invalid input',
      };
}

function projectId(context: AgentRuntimeContext): string | null {
  return context.route.kind === 'test'
    ? (context.route.projectId ?? null)
    : context.route.projectId;
}

function modelData(snapshot: AgentWorkingMemorySnapshot): string {
  if (!snapshot.exists) {
    return `WORKING_MEMORY.md is empty. Current revision: ${snapshot.revision}.`;
  }
  return [
    `WORKING_MEMORY.md · revision ${snapshot.revision} · about ${snapshot.approxTokens} tokens`,
    snapshot.contentMd,
  ].join('\n\n');
}

export interface AgentWorkingMemoryToolRuntimeOptions {
  load?: typeof loadAgentWorkingMemory;
  save?: typeof saveAgentWorkingMemory;
  database?: DbClient;
}

export class AgentWorkingMemoryToolRuntime implements AgentToolRuntime {
  private readonly load: typeof loadAgentWorkingMemory;
  private readonly save: typeof saveAgentWorkingMemory;

  constructor(options: AgentWorkingMemoryToolRuntimeOptions = {}) {
    this.load =
      options.load ??
      (options.database
        ? (projectId) => loadAgentWorkingMemory(projectId, options.database)
        : loadAgentWorkingMemory);
    this.save =
      options.save ??
      (options.database
        ? (projectId, input) =>
            saveAgentWorkingMemoryInDatabase(projectId, input, options.database!)
        : saveAgentWorkingMemory);
  }

  listDefinitions(): readonly AgentToolDefinition[] {
    return [
      {
        name: AGENT_WORKING_MEMORY_READ_TOOL,
        description:
          'Read the current project-scoped WORKING_MEMORY.md shared by all General Agent conversations. It contains only recent high-signal work context and may have forgotten older work. The current document is already supplied at turn start; call this only to refresh after a concurrent revision conflict.',
        inputSchema: readSchema,
        access: 'read',
        validateInput: (input) => validate(readSchema, input),
      },
      {
        name: AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
        description:
          'Checkpoint shared Working Memory exactly once before the final response. Use update only when another Agent would otherwise repeat important work, miss an unresolved issue, or misunderstand a durable change. Keep Markdown concise, preserve unresolved Current items, place newest Recent entries first, remove stale items, and compact older details when near the budget. Never copy manuscript prose, chat transcript, routine commands, secrets, or minor changes. Use noop when nothing important changed. Copy expectedRevision from the turn-start Working Memory header or a fresh read.',
        inputSchema: checkpointSchema,
        access: 'write',
        validateInput: (input) => {
          const checked = validate(checkpointSchema, input);
          if (!checked.ok) return checked;
          const operation = checked.value.operation;
          const contentMd = checked.value.contentMd;
          if (operation === 'update' && (typeof contentMd !== 'string' || !contentMd.trim())) {
            return { ok: false, error: 'update requires non-empty contentMd' };
          }
          if (operation === 'noop' && contentMd !== undefined) {
            return { ok: false, error: 'noop must omit contentMd' };
          }
          return checked;
        },
      },
    ];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    const targetProjectId = projectId(request.context);
    if (!targetProjectId) {
      return { ok: false, error: 'Working Memory requires a project-owned route.' };
    }
    try {
      if (request.name === AGENT_WORKING_MEMORY_READ_TOOL) {
        const snapshot = await this.load(targetProjectId);
        throwIfAgentAborted(request.signal);
        return { ok: true, data: snapshot, modelData: modelData(snapshot) };
      }
      if (request.name !== AGENT_WORKING_MEMORY_CHECKPOINT_TOOL) {
        return { ok: false, error: `Unknown Working Memory tool "${request.name}".` };
      }
      const expectedRevision = request.arguments.expectedRevision as number;
      if (request.arguments.operation === 'noop') {
        const snapshot = await this.load(targetProjectId);
        throwIfAgentAborted(request.signal);
        if (snapshot.revision !== expectedRevision) {
          throw new AgentWorkingMemoryConflictError(expectedRevision, snapshot.revision);
        }
        return {
          ok: true,
          data: { operation: 'noop', revision: snapshot.revision },
          modelData: 'Working Memory checkpoint complete: no important shared context changed.',
        };
      }
      const result = await this.save(targetProjectId, {
        contentMd: request.arguments.contentMd as string,
        expectedRevision,
        updatedBy: 'agent',
      });
      return {
        ok: true,
        data: {
          operation: 'update',
          ...result,
        },
        modelData: `Working Memory saved at revision ${result.snapshot.revision} (${result.snapshot.approxTokens} tokens${result.compacted ? ', compacted' : ''}).`,
      };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      if (error instanceof AgentWorkingMemoryConflictError) {
        return { ok: false, error: `${error.code}: ${error.message}` };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Working Memory operation failed.',
      };
    }
  }
}

export function resolveAgentWorkingMemoryToolAccess(name: string): 'read' | 'write' | undefined {
  if (name === AGENT_WORKING_MEMORY_READ_TOOL) return 'read';
  if (name === AGENT_WORKING_MEMORY_CHECKPOINT_TOOL) return 'write';
  return undefined;
}

export function createAgentWorkingMemoryAwarePermissionPolicy(
  fallback: AgentToolPermissionPolicy,
): AgentToolPermissionPolicy {
  return {
    async decide(request) {
      const access = resolveAgentWorkingMemoryToolAccess(request.toolName);
      if (!access) return fallback.decide(request);
      if (access !== request.access) {
        return { decision: 'deny', reason: 'Working Memory tool access changed.' };
      }
      return { decision: 'allow', scope: 'once' };
    },
  };
}
