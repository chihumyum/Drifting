import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateAgentRuntimeReadReceipt } from '../../../domain/agent-runtime-freshness';
import { AGENT_READ_TOOLS } from '../tool-registry';
import { useDataStore } from '../../../store/data-store';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import {
  DriftingReadToolRuntime,
  type TruncatedAgentToolResult,
} from './drifting-read-tool-runtime';
import type { AgentRuntimeContext, AgentToolExecutionRequest } from './types';
import {
  elementPatchRevision,
  elementPatchSetRevision,
} from './element-patch-revision';

const toolHandlerMocks = vi.hoisted(() => ({
  getActiveAgentToolContext: vi.fn(),
  pendingDeletedPatchIds: vi.fn(),
  runAgentTool: vi.fn(),
}));

vi.mock('../tool-handlers', () => ({
  getActiveAgentToolContext: toolHandlerMocks.getActiveAgentToolContext,
  pendingDeletedPatchIds: toolHandlerMocks.pendingDeletedPatchIds,
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
    control: {
      requestUserInput: async () => {
        throw new Error('read runtime test did not expect user input');
      },
    },
    ...overrides,
  };
}

describe('DriftingReadToolRuntime', () => {
  beforeEach(() => {
    toolHandlerMocks.getActiveAgentToolContext.mockReset();
    toolHandlerMocks.pendingDeletedPatchIds.mockReset();
    toolHandlerMocks.runAgentTool.mockReset();
    toolHandlerMocks.getActiveAgentToolContext.mockReturnValue(projectContext());
    toolHandlerMocks.pendingDeletedPatchIds.mockReturnValue(new Set());
    toolHandlerMocks.runAgentTool.mockResolvedValue({ ok: true });
    useDataStore.setState({ bookNodes: [], bookElements: [] });
  });

  it('only exposes read-certified catalog entries and runtime virtual tools', () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
    const definitions = runtime.listDefinitions(runtimeContext());
    const catalogDefinitions = definitions.filter(
      (definition) =>
        definition.name !== 'read_tool_result' &&
        definition.name !== 'ask_user',
    );

    expect(catalogDefinitions.map((definition) => definition.name)).toEqual(
      AGENT_READ_TOOLS.map((tool) => tool.name),
    );
    expect(catalogDefinitions.every((definition) => definition.access === 'read')).toBe(true);
    expect(
      catalogDefinitions.every((definition) => {
        const catalogEntry = AGENT_READ_TOOLS.find((tool) => tool.name === definition.name);
        return catalogEntry?.access === 'read' && catalogEntry.certification === 'read-certified';
      }),
    ).toBe(true);
    expect(definitions.slice(-2)).toEqual([
      expect.objectContaining({ name: 'ask_user', access: 'read' }),
      expect.objectContaining({ name: 'read_tool_result', access: 'read' }),
    ]);
  });

  it('rejects an unmounted or cross-project active context without dispatching', async () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
    toolHandlerMocks.getActiveAgentToolContext.mockReturnValueOnce(null);

    expect(() => runtime.listDefinitions(runtimeContext())).toThrow(
      'Drifting tool context is not mounted',
    );

    toolHandlerMocks.getActiveAgentToolContext.mockReturnValueOnce(null);
    await expect(runtime.execute(executionRequest())).resolves.toEqual({
      ok: false,
      error: 'Drifting tool context is not mounted',
    });

    toolHandlerMocks.getActiveAgentToolContext.mockReturnValue(projectContext('project-other'));
    await expect(runtime.execute(executionRequest())).resolves.toEqual({
      ok: false,
      error: 'Agent route does not match the active Drifting project',
    });
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
  });

  it('validates tool input schemas locally, including additional properties', () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
    const definitions = runtime.listDefinitions(runtimeContext());
    const readElement = definitions.find((definition) => definition.name === 'read_element');
    const readResult = definitions.find((definition) => definition.name === 'read_tool_result');
    const askUser = definitions.find((definition) => definition.name === 'ask_user');

    expect(readElement?.validateInput({})).toEqual(expect.objectContaining({ ok: false }));
    expect(readElement?.validateInput({ element: '林默', unexpected: true })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(readElement?.validateInput({ element: '林默' })).toEqual({
      ok: true,
      value: { element: '林默' },
    });
    expect(readResult?.validateInput({ resultRef: 'ref', limit: 16_001 })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(askUser?.validateInput({ prompt: '' })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(askUser?.validateInput({ prompt: 'Which ending do you prefer?' })).toEqual({
      ok: true,
      value: { prompt: 'Which ending do you prefer?' },
    });
  });

  it('pauses through the control plane and returns a provider-visible answer', async () => {
    const requestUserInput = vi.fn(async () => '保留开放式结尾');
    const runtime = new DriftingReadToolRuntime({ freshness: null });

    const response = await runtime.execute(
      executionRequest({
        name: 'ask_user',
        arguments: { prompt: '这一章要明确揭示真相吗？' },
        control: { requestUserInput },
      }),
    );

    expect(response).toEqual({
      ok: true,
      data: { answer: '保留开放式结尾' },
    });
    expect(requestUserInput).toHaveBeenCalledWith({
      requestId: 'agent-user-input:session-1:turn-1:call-1',
      prompt: '这一章要明确揭示真相吗？',
    });
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
  });

  it('replays a durable ask_user answer without asking the author twice', async () => {
    const requestUserInput = vi.fn(async () => '第一次答案');
    const persisted = new Map<string, CreateAgentRuntimeReadReceipt>();
    const freshness = {
      persistReadReceipt: vi.fn(async (input: CreateAgentRuntimeReadReceipt) => {
        persisted.set(input.id, input);
        return {
          outcome: 'inserted' as const,
          receipt: { ...input, result: input.result },
        };
      }),
      getReadReceipt: vi.fn(async (id: string) => {
        const receipt = persisted.get(id);
        return receipt ? { ...receipt, result: receipt.result } : null;
      }),
    } as unknown as AgentRuntimeFreshnessRepository;
    const runtime = new DriftingReadToolRuntime({
      freshness,
      artifacts: null,
    });
    const request = executionRequest({
      name: 'ask_user',
      arguments: { prompt: '选 A 还是 B？' },
      control: { requestUserInput },
    });

    await expect(runtime.execute(request)).resolves.toEqual({
      ok: true,
      data: {
        result: { answer: '第一次答案' },
        freshness: {
          receiptId: 'agent-read:session-1:turn-1:call-1',
          observations: [],
        },
      },
    });
    await expect(runtime.execute(request)).resolves.toEqual({
      ok: true,
      data: {
        result: { answer: '第一次答案' },
        freshness: {
          receiptId: 'agent-read:session-1:turn-1:call-1',
          observations: [],
        },
      },
    });
    expect(requestUserInput).toHaveBeenCalledTimes(1);
  });

  it('denies write access before dispatching even when the tool name is read-certified', async () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });

    await expect(
      runtime.execute(
        executionRequest({
          access: 'write',
          name: 'get_project_brief',
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Read-only Agent runtime denied write tool "get_project_brief"',
    });
    expect(toolHandlerMocks.runAgentTool).not.toHaveBeenCalled();
  });

  it('returns an explicit resultRef and reread instruction for oversized results', async () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
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
    const runtime = new DriftingReadToolRuntime({ freshness: null });
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
    expect((page.ok ? (page.data as { content: string }).content : '').includes('\uFFFD')).toBe(
      false,
    );
  });

  it('scopes stored result references to both session and project', async () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
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
    const runtime = new DriftingReadToolRuntime({ freshness: null });
    toolHandlerMocks.runAgentTool.mockRejectedValue(
      new Error('upstream rejected Bearer secret-token-123 and sk-private_credential'),
    );

    const response = await runtime.execute(executionRequest());

    expect(response).toEqual({
      ok: false,
      error: 'upstream rejected Bearer [REDACTED] and [REDACTED_API_KEY]',
    });
    expect(response.ok ? '' : response.error).not.toContain('secret-token-123');
    expect(response.ok ? '' : response.error).not.toContain('private_credential');
  });

  it('honors abort before dispatch and after an in-flight read resolves', async () => {
    const runtime = new DriftingReadToolRuntime({ freshness: null });
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

  it('binds prose reads to an exact Yjs revision/vector/hash and brackets dispatcher races', async () => {
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-1',
          projectId: 'project-1',
          title: 'Chapter One',
          updatedAt: 'node-r1',
        },
      ] as never,
    });
    const persistReadReceipt = vi.fn(async (input: CreateAgentRuntimeReadReceipt) => ({
      outcome: 'inserted' as const,
      receipt: { result: input.result },
    }));
    const freshness = {
      persistReadReceipt,
      getReadReceipt: vi.fn(async () => null),
    } as unknown as AgentRuntimeFreshnessRepository;
    const stableBase = {
      revision: 7,
      stateVector: Uint8Array.of(1, 2, 3),
      stateHash: `sha256:${'1'.repeat(64)}`,
    };
    const readProseBase = vi.fn(async () => stableBase);
    const runtime = new DriftingReadToolRuntime({
      freshness,
      artifacts: null,
      readProseBase,
    });

    const stable = await runtime.execute(
      executionRequest({
        name: 'read_node',
        arguments: { node: 'node-1' },
      }),
    );
    expect(stable.ok).toBe(true);
    expect(readProseBase).toHaveBeenCalledTimes(2);
    expect(persistReadReceipt.mock.calls[0]![0].observations).toEqual([
      {
        id: 'agent-observation:session-1:turn-1:call-1:0',
        entityKind: 'node',
        entityId: 'node-1',
        revision: 'node-r1',
      },
      {
        id: 'agent-observation:session-1:turn-1:call-1:1',
        entityKind: 'node_prose',
        entityId: 'node-1',
        revision: 'yjs:7',
        stateVector: Uint8Array.of(1, 2, 3),
        stateHash: `sha256:${'1'.repeat(64)}`,
      },
    ]);

    readProseBase.mockResolvedValueOnce(stableBase).mockResolvedValueOnce({
      ...stableBase,
      revision: 8,
      stateVector: Uint8Array.of(1, 2, 4),
      stateHash: `sha256:${'2'.repeat(64)}`,
    });
    const raced = await runtime.execute(
      executionRequest({
        callId: 'call-race',
        idempotencyKey: 'session-1:turn-1:call-race',
        name: 'read_node',
        arguments: { node: 'node-1' },
      }),
    );
    expect(raced).toEqual({
      ok: false,
      error: 'The node prose changed while it was being read; retry read_node before writing',
    });
    expect(persistReadReceipt).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture a Yjs freshness token for header-only read_node', async () => {
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-1',
          projectId: 'project-1',
          title: 'Chapter One',
          updatedAt: 'node-r1',
        },
      ] as never,
    });
    const persistReadReceipt = vi.fn(async (input: CreateAgentRuntimeReadReceipt) => ({
      outcome: 'inserted' as const,
      receipt: { result: input.result },
    }));
    const readProseBase = vi.fn();
    const runtime = new DriftingReadToolRuntime({
      freshness: {
        persistReadReceipt,
        getReadReceipt: vi.fn(async () => null),
      } as unknown as AgentRuntimeFreshnessRepository,
      artifacts: null,
      readProseBase,
    });

    const response = await runtime.execute(
      executionRequest({
        name: 'read_node',
        arguments: { node: 'node-1', prose: false },
      }),
    );

    expect(response.ok).toBe(true);
    expect(readProseBase).not.toHaveBeenCalled();
    expect(persistReadReceipt.mock.calls[0]![0].observations).toEqual([
      {
        id: 'agent-observation:session-1:turn-1:call-1:0',
        entityKind: 'node',
        entityId: 'node-1',
        revision: 'node-r1',
      },
    ]);
  });

  it('binds get_element_patches to both the exact set and each patch revision', async () => {
    useDataStore.setState({
      bookElements: [
        {
          id: 'element-1',
          projectId: 'project-1',
          name: '柳青',
        },
      ] as never,
    });
    const patch = {
      id: 'patch-1',
      projectId: 'project-1',
      elementId: 'element-1',
      sourceNodeId: null,
      sourceBlockId: null,
      sourceBlockText: null,
      textAnchorJson: null,
      invalidatedAt: null,
      title: '转变',
      contentJson: '{}',
      orderKey: 0,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const invalidatedPatch = {
      ...patch,
      id: 'patch-invalidated',
      invalidatedAt: '2026-07-30T01:00:00.000Z',
    };
    const pendingDeletedPatch = {
      ...patch,
      id: 'patch-pending-delete',
    };
    toolHandlerMocks.pendingDeletedPatchIds.mockReturnValue(
      new Set(['patch-pending-delete']),
    );
    const persistReadReceipt = vi.fn(
      async (input: CreateAgentRuntimeReadReceipt) => ({
        outcome: 'inserted' as const,
        receipt: { result: input.result },
      }),
    );
    const readElementPatches = vi.fn(async () => [
      patch,
      invalidatedPatch,
      pendingDeletedPatch,
    ]);
    const runtime = new DriftingReadToolRuntime({
      freshness: {
        persistReadReceipt,
        getReadReceipt: vi.fn(async () => null),
      } as unknown as AgentRuntimeFreshnessRepository,
      artifacts: null,
      readElementPatches,
    });
    toolHandlerMocks.runAgentTool.mockResolvedValue({
      patches: [{ patchId: patch.id, title: patch.title }],
    });

    const response = await runtime.execute(
      executionRequest({
        name: 'get_element_patches',
        arguments: { element: '柳青' },
      }),
    );

    if (!response.ok) throw new Error(response.error);
    expect(response.ok).toBe(true);
    expect(persistReadReceipt.mock.calls[0]![0].observations).toEqual([
      {
        id: 'agent-observation:session-1:turn-1:call-1:0',
        entityKind: 'element_patch_set',
        entityId: 'element-1',
        revision: await elementPatchSetRevision([patch]),
      },
      {
        id: 'agent-observation:session-1:turn-1:call-1:1',
        entityKind: 'element_patch',
        entityId: 'patch-1',
        revision: await elementPatchRevision(patch),
      },
    ]);

    readElementPatches.mockReset();
    readElementPatches
      .mockResolvedValueOnce([patch])
      .mockResolvedValueOnce([{ ...patch, title: '并发修改' }]);
    const raced = await runtime.execute(
      executionRequest({
        callId: 'patch-race',
        idempotencyKey: 'session-1:turn-1:patch-race',
        name: 'get_element_patches',
        arguments: { element: '柳青' },
      }),
    );
    expect(raced).toEqual({
      ok: false,
      error:
        'Element patches changed while they were being read; retry get_element_patches before writing',
    });
    expect(persistReadReceipt).toHaveBeenCalledTimes(1);
  });
});
