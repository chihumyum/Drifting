import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_READ_TOOLS } from '../tool-registry';
import {
  DriftingReadToolRuntime,
  type TruncatedAgentToolResult,
} from './drifting-read-tool-runtime';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
} from './types';

const toolHandlerMocks = vi.hoisted(() => ({
  getActiveAgentToolContext: vi.fn(),
  runAgentTool: vi.fn(),
}));

vi.mock('../tool-handlers', () => ({
  getActiveAgentToolContext: toolHandlerMocks.getActiveAgentToolContext,
  runAgentTool: toolHandlerMocks.runAgentTool,
}));

const projectContext = (projectId = 'project-1') => ({
  projectId,
  write: {},
});

const runtimeContext = (projectId = 'project-1'): AgentRuntimeContext => ({
  route: { kind: 'chat', projectId },
});

function executionRequest(
  overrides: Partial<AgentToolExecutionRequest> = {},
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    idempotencyKey: 'session-1:turn-1:call-1',
    name: 'get_project_brief',
    arguments: {},
    access: 'read',
    context: runtimeContext(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('DriftingReadToolRuntime', () => {
  beforeEach(() => {
    toolHandlerMocks.getActiveAgentToolContext.mockReset();
    toolHandlerMocks.runAgentTool.mockReset();
    toolHandlerMocks.getActiveAgentToolContext.mockReturnValue(projectContext());
    toolHandlerMocks.runAgentTool.mockResolvedValue({ ok: true });
  });

  it('only exposes read-certified catalog entries and the result paging tool', () => {
    const runtime = new DriftingReadToolRuntime();
    const definitions = runtime.listDefinitions(runtimeContext());
    const catalogDefinitions = definitions.filter(
      (definition) => definition.name !== 'read_tool_result',
    );

    expect(catalogDefinitions.map((definition) => definition.name)).toEqual(
      AGENT_READ_TOOLS.map((tool) => tool.name),
    );
    expect(
      catalogDefinitions.every((definition) => definition.access === 'read'),
    ).toBe(true);
    expect(
      catalogDefinitions.every((definition) => {
        const catalogEntry = AGENT_READ_TOOLS.find(
          (tool) => tool.name === definition.name,
        );
        return (
          catalogEntry?.access === 'read' &&
          catalogEntry.certification === 'read-certified'
        );
      }),
    ).toBe(true);
    expect(definitions[definitions.length - 1]).toEqual(
      expect.objectContaining({
        name: 'read_tool_result',
        access: 'read',
      }),
    );
  });

  it('rejects an unmounted or cross-project active context without dispatching', async () => {
    const runtime = new DriftingReadToolRuntime();
    toolHandlerMocks.getActiveAgentToolContext.mockReturnValueOnce(null);

    expect(() => runtime.listDefinitions(runtimeContext())).toThrow(
      'Drifting tool context is not mounted',
    );

    toolHandlerMocks.getActiveAgentToolContext.mockReturnValueOnce(null);
    await expect(runtime.execute(executionRequest())).resolves.toEqual({
      ok: false,
      error: 'Drifting tool context is not mounted',
    });

    toolHandlerMocks.getActiveAgentToolContext.mockReturnValue(
      projectContext('project-other'),
    );
    await expect(runtime.execute(executionRequest())).resolves.toEqual({
      ok: false,
      error: 'Agent route does not match the active Drifting project',
    });
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
  });

  it('validates tool input schemas locally, including additional properties', () => {
    const runtime = new DriftingReadToolRuntime();
    const definitions = runtime.listDefinitions(runtimeContext());
    const readElement = definitions.find(
      (definition) => definition.name === 'read_element',
    );
    const readResult = definitions.find(
      (definition) => definition.name === 'read_tool_result',
    );

    expect(readElement?.validateInput({})).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      readElement?.validateInput({ element: '林默', unexpected: true }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(readElement?.validateInput({ element: '林默' })).toEqual({
      ok: true,
      value: { element: '林默' },
    });
    expect(
      readResult?.validateInput({ resultRef: 'ref', limit: 16_001 }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it('denies write access before dispatching even when the tool name is read-certified', async () => {
    const runtime = new DriftingReadToolRuntime();

    await expect(
      runtime.execute(
        executionRequest({
          access: 'write',
          name: 'get_project_brief',
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'Read-only Agent runtime denied write tool "get_project_brief"',
    });
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
  });

  it('returns an explicit resultRef and reread instruction for oversized results', async () => {
    const runtime = new DriftingReadToolRuntime();
    const oversized = 'x'.repeat(12_001);
    toolHandlerMocks.runAgentTool.mockResolvedValue(oversized);

    const response = await runtime.execute(executionRequest());

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const data = response.data as TruncatedAgentToolResult;
    expect(data).toEqual({
      truncated: true,
      resultRef: 'agent-result:session-1:turn-1:call-1',
      preview: 'x'.repeat(4_000),
      totalChars: 12_001,
      reread: {
        tool: 'read_tool_result',
        arguments: {
          resultRef: 'agent-result:session-1:turn-1:call-1',
          offset: 4_000,
          limit: 12_000,
        },
      },
    });
  });

  it('pages Chinese and emoji by Unicode code points without splitting surrogate pairs', async () => {
    const runtime = new DriftingReadToolRuntime();
    const oversized = '中😀'.repeat(7_000);
    const codePoints = [...oversized];
    toolHandlerMocks.runAgentTool.mockResolvedValue(oversized);

    const first = await runtime.execute(executionRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const truncated = first.data as TruncatedAgentToolResult;
    expect(truncated.totalChars).toBe(14_000);
    expect([...truncated.preview]).toHaveLength(4_000);

    const page = await runtime.execute(
      executionRequest({
        name: 'read_tool_result',
        arguments: {
          resultRef: truncated.resultRef,
          offset: 3_999,
          limit: 7,
        },
        callId: 'page-1',
      }),
    );

    expect(page).toEqual({
      ok: true,
      data: {
        resultRef: truncated.resultRef,
        sourceTool: 'get_project_brief',
        sourceArguments: {},
        offset: 3_999,
        nextOffset: 4_006,
        totalChars: 14_000,
        truncated: true,
        content: codePoints.slice(3_999, 4_006).join(''),
        reread: {
          tool: 'read_tool_result',
          arguments: {
            resultRef: truncated.resultRef,
            offset: 4_006,
            limit: 7,
          },
        },
      },
    });
    expect(
      (page.ok ? (page.data as { content: string }).content : '').includes(
        '\uFFFD',
      ),
    ).toBe(false);
  });

  it('scopes stored result references to both session and project', async () => {
    const runtime = new DriftingReadToolRuntime();
    toolHandlerMocks.runAgentTool.mockResolvedValue('x'.repeat(12_001));
    const first = await runtime.execute(executionRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const { resultRef } = first.data as TruncatedAgentToolResult;

    await expect(
      runtime.execute(
        executionRequest({
          name: 'read_tool_result',
          sessionId: 'session-other',
          arguments: { resultRef },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'The requested Agent result is unavailable in this session',
    });
    await expect(
      runtime.execute(
        executionRequest({
          name: 'read_tool_result',
          context: runtimeContext('project-other'),
          arguments: { resultRef },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'The requested Agent result is unavailable in this session',
    });
    expect(toolHandlerMocks.runAgentTool).toHaveBeenCalledTimes(1);
  });

  it('redacts bearer tokens and API keys from dispatcher errors', async () => {
    const runtime = new DriftingReadToolRuntime();
    toolHandlerMocks.runAgentTool.mockRejectedValue(
      new Error(
        'upstream rejected Bearer secret-token-123 and sk-private_credential',
      ),
    );

    const response = await runtime.execute(executionRequest());

    expect(response).toEqual({
      ok: false,
      error:
        'upstream rejected Bearer [REDACTED] and [REDACTED_API_KEY]',
    });
    expect(response.ok ? '' : response.error).not.toContain('secret-token-123');
    expect(response.ok ? '' : response.error).not.toContain(
      'private_credential',
    );
  });

  it('honors abort before dispatch and after an in-flight read resolves', async () => {
    const runtime = new DriftingReadToolRuntime();
    const beforeController = new AbortController();
    beforeController.abort('abort before read');

    await expect(
      runtime.execute(
        executionRequest({
          signal: beforeController.signal,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentRuntimeAbortError',
        message: 'abort before read',
      }),
    );
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();

    let releaseRead: ((value: unknown) => void) | undefined;
    toolHandlerMocks.runAgentTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    const duringController = new AbortController();
    const pending = runtime.execute(
      executionRequest({
        signal: duringController.signal,
      }),
    );
    await vi.waitFor(() => {
      expect(toolHandlerMocks.runAgentTool).toHaveBeenCalledTimes(1);
    });
    duringController.abort('abort during read');
    releaseRead?.({ tooLate: true });

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentRuntimeAbortError',
        message: 'abort during read',
      }),
    );
  });
});
