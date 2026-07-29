import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  getActiveAgentToolContext,
  runAgentTool,
  type AgentToolContext,
} from '../tool-handlers';
import { AGENT_READ_TOOLS, type RegisteredTool } from '../tool-registry';
import {
  isAgentAbort,
  throwIfAgentAborted,
} from './errors';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolRuntime,
} from './types';

const RESULT_PAGE_TOOL = 'read_tool_result';
const DEFAULT_MAX_STORED_RESULTS = 128;
const DEFAULT_MAX_STORED_CHARS = 8 * 1024 * 1024;
const MAX_RESULT_PAGE_CHARS = 16_000;

/** Canonical P1 catalog lookup used by durable tool lifecycle projection. */
export function resolveDriftingReadToolAccess(
  name: string,
): 'read' | undefined {
  return name === RESULT_PAGE_TOOL ||
    AGENT_READ_TOOLS.some((tool) => tool.name === name)
    ? 'read'
    : undefined;
}

interface StoredReadResult {
  ref: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  serialized: string;
}

export interface DriftingReadToolRuntimeOptions {
  getContext?: () => AgentToolContext | null;
  maxStoredResults?: number;
  maxStoredChars?: number;
}

export interface TruncatedAgentToolResult {
  truncated: true;
  resultRef: string;
  preview: string;
  totalChars: number;
  reread: {
    tool: typeof RESULT_PAGE_TOOL;
    arguments: {
      resultRef: string;
      offset: number;
      limit: number;
    };
  };
}

/**
 * Production read-only bridge from the provider-neutral runtime to Drifting's
 * canonical renderer dispatcher.
 *
 * It never receives an `AgentWriteApi` capability directly and only exposes
 * entries from `AGENT_READ_TOOLS`. The active renderer context is checked both
 * before and after every read so a project switch cannot return data from the
 * previously mounted project.
 */
export class DriftingReadToolRuntime implements AgentToolRuntime {
  private readonly getContext: () => AgentToolContext | null;
  private readonly maxStoredResults: number;
  private readonly maxStoredChars: number;
  private readonly storedResults = new Map<string, StoredReadResult>();
  private storedChars = 0;

  constructor(options: DriftingReadToolRuntimeOptions = {}) {
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.maxStoredResults =
      options.maxStoredResults ?? DEFAULT_MAX_STORED_RESULTS;
    this.maxStoredChars = options.maxStoredChars ?? DEFAULT_MAX_STORED_CHARS;
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    this.requireMatchingContext(context);
    return [
      ...AGENT_READ_TOOLS.map((tool) => this.toDefinition(tool)),
      resultPageDefinition(),
    ];
  }

  async execute(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    if (request.access !== 'read') {
      return {
        ok: false,
        error: `Read-only Agent runtime denied write tool "${request.name}"`,
      };
    }

    if (request.name === RESULT_PAGE_TOOL) {
      return this.readStoredResult(request);
    }

    const catalogEntry = AGENT_READ_TOOLS.find(
      (tool) => tool.name === request.name,
    );
    if (!catalogEntry) {
      return {
        ok: false,
        error: `Tool "${request.name}" is not in the read-certified catalog`,
      };
    }

    try {
      const active = this.requireMatchingContext(request.context);
      const data = await runAgentTool(
        request.name,
        request.arguments,
        active,
      );
      throwIfAgentAborted(request.signal);
      this.requireMatchingContext(request.context);
      return {
        ok: true,
        data: this.budgetResult(request, catalogEntry, data),
      };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return { ok: false, error: publicToolError(error) };
    }
  }

  private toDefinition(tool: RegisteredTool): AgentToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parametersSchema,
      access: 'read',
      validateInput: (input) => validateToolInput(tool, input),
    };
  }

  private requireMatchingContext(
    runtimeContext: AgentRuntimeContext,
  ): AgentToolContext {
    const active = this.getContext();
    if (!active) {
      throw new Error('Drifting tool context is not mounted');
    }
    const routeProjectId = runtimeContext.route.projectId;
    if (routeProjectId && routeProjectId !== active.projectId) {
      throw new Error('Agent route does not match the active Drifting project');
    }
    return active;
  }

  private budgetResult(
    request: AgentToolExecutionRequest,
    tool: RegisteredTool,
    data: unknown,
  ): unknown {
    const serialized = serializeResult(data);
    if (serialized.length <= tool.resultBudgetChars) return data;

    const resultRef = [
      'agent-result',
      request.sessionId,
      request.turnId,
      request.callId,
    ].join(':');
    this.storeResult({
      ref: resultRef,
      projectId: request.context.route.projectId ?? '',
      sessionId: request.sessionId,
      toolName: request.name,
      arguments: request.arguments,
      serialized,
    });
    const previewLimit = Math.min(tool.resultBudgetChars, 4_000);
    const result: TruncatedAgentToolResult = {
      truncated: true,
      resultRef,
      preview: sliceCodePoints(serialized, 0, previewLimit),
      totalChars: codePointLength(serialized),
      reread: {
        tool: RESULT_PAGE_TOOL,
        arguments: {
          resultRef,
          offset: previewLimit,
          limit: Math.min(MAX_RESULT_PAGE_CHARS, tool.resultBudgetChars),
        },
      },
    };
    return result;
  }

  private readStoredResult(
    request: AgentToolExecutionRequest,
  ): AgentToolExecutionResult {
    const resultRef = String(request.arguments.resultRef ?? '');
    const stored = this.storedResults.get(resultRef);
    if (
      !stored ||
      stored.sessionId !== request.sessionId ||
      stored.projectId !== (request.context.route.projectId ?? '')
    ) {
      return {
        ok: false,
        error: 'The requested Agent result is unavailable in this session',
      };
    }
    const offset = Number(request.arguments.offset ?? 0);
    const limit = Number(request.arguments.limit ?? MAX_RESULT_PAGE_CHARS);
    const totalChars = codePointLength(stored.serialized);
    const content = sliceCodePoints(stored.serialized, offset, limit);
    const nextOffset = Math.min(totalChars, offset + codePointLength(content));
    return {
      ok: true,
      data: {
        resultRef,
        sourceTool: stored.toolName,
        sourceArguments: stored.arguments,
        offset,
        nextOffset,
        totalChars,
        truncated: nextOffset < totalChars,
        content,
        ...(nextOffset < totalChars
          ? {
              reread: {
                tool: RESULT_PAGE_TOOL,
                arguments: { resultRef, offset: nextOffset, limit },
              },
            }
          : {}),
      },
    };
  }

  private storeResult(result: StoredReadResult): void {
    const existing = this.storedResults.get(result.ref);
    if (existing) {
      this.storedChars -= existing.serialized.length;
      this.storedResults.delete(result.ref);
    }
    this.storedResults.set(result.ref, result);
    this.storedChars += result.serialized.length;

    while (
      this.storedResults.size > this.maxStoredResults ||
      (this.storedChars > this.maxStoredChars && this.storedResults.size > 1)
    ) {
      const oldest = this.storedResults.entries().next().value as
        | [string, StoredReadResult]
        | undefined;
      if (!oldest) break;
      this.storedResults.delete(oldest[0]);
      this.storedChars -= oldest[1].serialized.length;
    }
  }
}

export function createDriftingReadToolRuntime(
  options?: DriftingReadToolRuntimeOptions,
): AgentToolRuntime {
  return new DriftingReadToolRuntime(options);
}

function resultPageDefinition(): AgentToolDefinition {
  const schema = Type.Object(
    {
      resultRef: Type.String({
        minLength: 1,
        description: 'resultRef returned by a truncated read tool',
      }),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: 'Unicode character offset, default 0',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_RESULT_PAGE_CHARS,
        description: `Maximum Unicode characters, up to ${MAX_RESULT_PAGE_CHARS}`,
      })),
    },
    { additionalProperties: false },
  );
  return {
    name: RESULT_PAGE_TOOL,
    description:
      'Continue reading a truncated tool result by resultRef. Use the returned reread arguments until truncated=false.',
    inputSchema: schema,
    access: 'read',
    validateInput: (input) => {
      if (!Value.Check(schema, input)) {
        return {
          ok: false,
          error: formatSchemaErrors(schema, input),
        };
      }
      return {
        ok: true,
        value: {
          resultRef: input.resultRef,
          offset: input.offset ?? 0,
          limit: input.limit ?? MAX_RESULT_PAGE_CHARS,
        },
      };
    },
  };
}

function validateToolInput(
  tool: RegisteredTool,
  input: Record<string, unknown>,
) {
  if (Value.Check(tool.parametersSchema as TSchema, input)) {
    return { ok: true as const, value: input };
  }
  return {
    ok: false as const,
    error: formatSchemaErrors(tool.parametersSchema, input),
  };
}

function formatSchemaErrors(schema: object, input: unknown): string {
  const errors = [...Value.Errors(schema as TSchema, input)]
    .slice(0, 4)
    .map((error) => `${error.path || '/'} ${error.message}`);
  return errors.join('; ') || 'Input did not match the tool schema';
}

function serializeResult(data: unknown): string {
  if (typeof data === 'string') return data;
  const serialized = JSON.stringify(data);
  return serialized ?? '';
}

function publicToolError(error: unknown): string {
  if (!(error instanceof Error)) return 'Drifting tool execution failed';
  return error.message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .slice(0, 500);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function sliceCodePoints(value: string, offset: number, limit: number): string {
  return [...value].slice(offset, offset + limit).join('');
}
