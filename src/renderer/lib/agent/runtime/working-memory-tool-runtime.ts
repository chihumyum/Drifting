import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  AgentWorkingMemoryConflictError,
  EMPTY_AGENT_WORKING_MEMORY_MD,
  type AgentWorkingMemorySnapshot,
} from '../../../domain/agent-working-memory';
import {
  applyAgentWorkingMemoryEdits,
  type AgentWorkingMemoryEdit,
} from './working-memory-document';
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
  AGENT_WORKING_MEMORY_EDIT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';

export {
  AGENT_WORKING_MEMORY_EDIT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';

const readSchema = Type.Object({}, { additionalProperties: false });
const editSchema = Type.Object(
  {
    expectedRevision: Type.Integer({
      minimum: 0,
      description: 'Exact revision from the turn-start Working Memory header or a fresh read',
    }),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String({
            minLength: 1,
            description: 'Exact passage to replace; it must occur exactly once',
          }),
          newText: Type.String({ description: 'Replacement text; empty deletes the passage' }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, description: 'Applied in order, each against the result of the previous one' },
    ),
  },
  { additionalProperties: false },
);

function validate(schema: typeof readSchema | typeof editSchema, value: unknown) {
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
    return [
      `WORKING_MEMORY.md has no entries yet · revision ${snapshot.revision}. Edit this starting outline:`,
      EMPTY_AGENT_WORKING_MEMORY_MD,
    ].join('\n\n');
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
          'Read shared project WORKING_MEMORY.md. The turn-start copy may be stale after concurrent work; this returns the current content and revision.',
        inputSchema: readSchema,
        access: 'read',
        validateInput: (input) => validate(readSchema, input),
      },
      {
        name: AGENT_WORKING_MEMORY_EDIT_TOOL,
        description:
          'Edit shared Working Memory in place with exact passage replacements, as you would edit a Markdown file. Use it only when important shared context changes: add or update unresolved Current items and newest Recent results, move lasting author or project context into PROJECT_MEMORY.md, and delete stale detail. Supply expectedRevision from the turn-start header or a fresh read.',
        inputSchema: editSchema,
        access: 'write',
        validateInput: (input) => validate(editSchema, input),
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
      if (request.name !== AGENT_WORKING_MEMORY_EDIT_TOOL) {
        return { ok: false, error: `Unknown Working Memory tool "${request.name}".` };
      }
      const expectedRevision = request.arguments.expectedRevision as number;
      const current = await this.load(targetProjectId);
      throwIfAgentAborted(request.signal);
      if (current.revision !== expectedRevision) {
        throw new AgentWorkingMemoryConflictError(expectedRevision, current.revision);
      }
      const contentMd = applyAgentWorkingMemoryEdits(
        current.exists ? current.contentMd : EMPTY_AGENT_WORKING_MEMORY_MD,
        request.arguments.edits as AgentWorkingMemoryEdit[],
      );
      const result = await this.save(targetProjectId, {
        contentMd,
        expectedRevision,
        updatedBy: 'agent',
      });
      return {
        ok: true,
        data: result,
        modelData: `Working Memory saved at revision ${result.snapshot.revision} (${result.snapshot.approxTokens} tokens).`,
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
  if (name === AGENT_WORKING_MEMORY_EDIT_TOOL) return 'write';
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
