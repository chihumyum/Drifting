import { describe, expect, it } from 'vitest';
import {
  agentModelMessagesToContextSources,
  AgentContextMessageBridgeError,
  createAgentContextProviderEnvelope,
  estimateAgentContextFixedInputTokens,
  planAgentModelContext,
  projectAgentContextToProvider,
  rebuildAgentContextProviderProjection,
  verifyAgentContextProviderEnvelope,
  type AgentContextProviderEnvelopeV2,
  type AgentContextProviderProjection,
  type AgentContextToolAccessResolver,
} from './context-message-adapter';
import {
  createAgentContextSummaryCandidate,
  planAgentContext,
} from './context-planner';
import {
  agentRuntimeUnknownToolResultContent,
  type AgentModelMessage,
  type AgentModelToolDefinition,
  type AgentToolResultBlock,
} from './types';

const resolveToolAccess: AgentContextToolAccessResolver = (name) => {
  if (name === 'read_node') return 'read';
  if (name === 'rename_node') return 'write';
  return null;
};

function toolCall(input: {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}) {
  return {
    type: 'tool_call' as const,
    callId: input.callId,
    name: input.name,
    arguments: input.arguments,
    rawArguments:
      input.rawArguments ?? JSON.stringify(input.arguments),
  };
}

function deniedToolResult(
  callId: string,
  name: string,
): AgentToolResultBlock {
  return {
    callId,
    name,
    ok: false,
    content: agentRuntimeUnknownToolResultContent(name),
    source: 'runtime',
    errorCode: 'UNKNOWN_TOOL',
  };
}

function canonicalMessages(
  projection: AgentContextProviderProjection,
): AgentModelMessage[] {
  return projection.messages.flatMap((message) =>
    message.type === 'model_message' ? [message.message] : [],
  );
}

function cloneEnvelope(
  envelope: AgentContextProviderEnvelopeV2,
): AgentContextProviderEnvelopeV2 {
  return structuredClone(envelope);
}

describe('AgentModelMessage context bridge', () => {
  it('round-trips mixed text/thinking/read/write history and exact pinned runtime facts', async () => {
    const systemPrompt = '  SYSTEM\nkeep exact bytes\u0000  ';
    const messages: AgentModelMessage[] = [
      { role: 'user', content: '  first user\nexact  ' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read.' },
          { type: 'thinking', text: 'discardable private thought' },
          toolCall({
            callId: 'shared-call',
            name: 'read_node',
            arguments: { node: 'chapter-1', include: ['summary', 'body'] },
            rawArguments:
              '{"node":"chapter-1","include":["summary","body"]}',
          }),
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: 'shared-call',
            name: 'read_node',
            ok: true,
            content: '  read result\nbyte exact  ',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Read complete.' }],
      },
      { role: 'user', content: 'Rename it exactly.' },
      {
        role: 'assistant',
        content: [
          toolCall({
            callId: 'shared-call',
            name: 'rename_node',
            arguments: { node: 'chapter-1', title: '新标题' },
            rawArguments: '{"node":"chapter-1","title":"新标题"}',
          }),
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: 'shared-call',
            name: 'rename_node',
            ok: true,
            content: '{"revision":42,"title":"新标题"}',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Rename complete.' }],
      },
    ];
    const supplementalRows = [
      {
        sourceId: 'review:shared-call',
        turnOrdinal: 1,
        kind: 'write_review' as const,
        content: '  accepted\nexact  ',
      },
      {
        sourceId: 'revert:shared-call',
        turnOrdinal: 1,
        kind: 'write_revert' as const,
        content: 'not-reverted\u0000exact',
      },
      {
        sourceId: 'freshness:chapter-1',
        turnOrdinal: null,
        kind: 'freshness' as const,
        content: 'revision=42;hash=abc',
      },
    ];

    const firstBridge = agentModelMessagesToContextSources({
      systemPrompt,
      messages,
      resolveToolAccess,
      supplementalRows,
    });
    const secondBridge = agentModelMessagesToContextSources({
      systemPrompt,
      messages,
      resolveToolAccess,
      supplementalRows,
    });
    expect(secondBridge).toEqual(firstBridge);
    expect(
      firstBridge.sourceRows.filter((row) => row.kind === 'tool_call'),
    ).toMatchObject([
      {
        turnOrdinal: 0,
        callId: 'shared-call',
        toolName: 'read_node',
        toolAccess: 'read',
      },
      {
        turnOrdinal: 1,
        callId: 'shared-call',
        toolName: 'rename_node',
        toolAccess: 'write',
      },
    ]);

    const result = await planAgentModelContext({
      systemPrompt,
      messages,
      resolveToolAccess,
      supplementalRows,
      planner: {
        contextWindowTokens: 20_000,
        requestedOutputTokens: 2_000,
        fixedInputTokens: 317,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const projection = result.envelope.providerContext;
    expect(projection.systemPrompt).toBe(systemPrompt);
    expect(
      projection.messages.some(
        (message) => message.type === 'context_summary',
      ),
    ).toBe(false);
    expect(
      projection.messages
        .filter((message) => message.type === 'context_note')
        .map((message) => ({
          kind: message.noteKind,
          content: message.content,
        })),
    ).toEqual(
      supplementalRows.map((row) => ({
        kind: row.kind,
        content: row.content,
      })),
    );

    const projectedCanonical = canonicalMessages(projection);
    expect(projectedCanonical).toEqual([
      messages[0],
      {
        role: 'assistant',
        content: [
          (messages[1] as Extract<
            AgentModelMessage,
            { role: 'assistant' }
          >).content[0],
          (messages[1] as Extract<
            AgentModelMessage,
            { role: 'assistant' }
          >).content[2],
        ],
      },
      ...messages.slice(2),
    ]);
    expect(result.plan.checkpoint.budget.fixedInputTokens).toBe(317);

    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: result.envelope,
        canonicalSourceRows: result.bridge.sourceRows,
      }),
    ).resolves.toBeUndefined();
    await expect(
      rebuildAgentContextProviderProjection({
        envelope: result.envelope,
        canonicalSourceRows: result.bridge.sourceRows,
      }),
    ).resolves.toEqual(projection);
  });

  it('scopes call ids by turn, but rejects same-turn reuse and dangling topology', () => {
    const valid: AgentModelMessage[] = [
      { role: 'user', content: 'turn zero' },
      {
        role: 'assistant',
        content: [
          toolCall({
            callId: 'provider-reused-id',
            name: 'read_node',
            arguments: { id: 'a' },
          }),
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: 'provider-reused-id',
            name: 'read_node',
            ok: true,
            content: 'a',
          },
        ],
      },
      { role: 'user', content: 'turn one' },
      {
        role: 'assistant',
        content: [
          toolCall({
            callId: 'provider-reused-id',
            name: 'read_node',
            arguments: { id: 'b' },
          }),
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: 'provider-reused-id',
            name: 'read_node',
            ok: true,
            content: 'b',
          },
        ],
      },
    ];
    const bridge = agentModelMessagesToContextSources({
      systemPrompt: 'policy',
      messages: valid,
      resolveToolAccess,
    });
    expect(
      bridge.sourceRows
        .filter((row) => row.kind === 'tool_call')
        .map((row) => `${row.turnOrdinal}:${row.callId}`),
    ).toEqual(['0:provider-reused-id', '1:provider-reused-id']);

    expect(() =>
      agentModelMessagesToContextSources({
        systemPrompt: 'policy',
        messages: [
          { role: 'user', content: 'duplicate' },
          {
            role: 'assistant',
            content: [
              toolCall({
                callId: 'duplicate',
                name: 'read_node',
                arguments: {},
              }),
              toolCall({
                callId: 'duplicate',
                name: 'read_node',
                arguments: {},
              }),
            ],
          },
        ],
        resolveToolAccess,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentContextMessageBridgeError>>({
        code: 'INVALID_TOOL_TOPOLOGY',
      }),
    );
    expect(() =>
      agentModelMessagesToContextSources({
        systemPrompt: 'policy',
        messages: [
          { role: 'user', content: 'dangling' },
          {
            role: 'assistant',
            content: [
              toolCall({
                callId: 'dangling',
                name: 'read_node',
                arguments: {},
              }),
            ],
          },
        ],
        resolveToolAccess,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentContextMessageBridgeError>>({
        code: 'INVALID_TOOL_TOPOLOGY',
      }),
    );
  });

  it('emits summaries as explicit context messages while preserving the latest two turns', async () => {
    const messages: AgentModelMessage[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      messages.push({ role: 'user', content: `user-${turn}` });
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text:
              turn < 2
                ? `old-${turn}:${'x'.repeat(12_000)}`
                : `recent-${turn}:byte-exact`,
          },
        ],
      });
    }
    const bridge = agentModelMessagesToContextSources({
      systemPrompt: 'policy',
      messages,
      resolveToolAccess,
    });
    const oldNarratives = bridge.sourceRows.filter(
      (row) =>
        row.kind === 'assistant_narrative' &&
        row.turnOrdinal !== null &&
        row.turnOrdinal < 2,
    );
    const deterministicSummaries = await Promise.all(
      oldNarratives.map((row) =>
        createAgentContextSummaryCandidate({
          summaryId: `summary:${row.turnOrdinal}`,
          sourceRows: [row],
          content: `Verified summary for turn ${row.turnOrdinal}.`,
        }),
      ),
    );
    const planned = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 200,
      sourceRows: bridge.sourceRows,
      deterministicSummaries,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const projection = projectAgentContextToProvider({
      segments: planned.plan.segments,
      bindings: bridge.bindings,
    });
    const summaries = projection.messages.filter(
      (message) => message.type === 'context_summary',
    );
    expect(summaries).toHaveLength(2);
    expect(
      projection.messages.some(
        (message) =>
          message.type === 'context_summary' &&
          'message' in message,
      ),
    ).toBe(false);
    expect(
      projection.messages.some(
        (message) =>
          message.type === 'model_message' &&
          message.message.role === 'tool',
      ),
    ).toBe(false);
    const recentTexts = canonicalMessages(projection).flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) =>
            block.type === 'text' ? [block.text] : [],
          )
        : [],
    );
    expect(recentTexts).toEqual([
      'recent-2:byte-exact',
      'recent-3:byte-exact',
    ]);

    const envelope = await createAgentContextProviderEnvelope({
      bridge,
      plan: planned.plan,
    });
    await expect(
      rebuildAgentContextProviderProjection({
        envelope,
        canonicalSourceRows: bridge.sourceRows,
      }),
    ).resolves.toEqual(projection);
  });

  it('fails closed on envelope or canonical-source tampering', async () => {
    const result = await planAgentModelContext({
      systemPrompt: 'policy',
      messages: [
        { role: 'user', content: 'keep this exact' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
      ],
      resolveToolAccess,
      planner: {
        contextWindowTokens: 10_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 100,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const providerTamper = cloneEnvelope(result.envelope);
    const firstModelMessage = providerTamper.providerContext.messages.find(
      (message) => message.type === 'model_message',
    );
    if (
      !firstModelMessage ||
      firstModelMessage.message.role !== 'user'
    ) {
      throw new Error('fixture lost user message');
    }
    firstModelMessage.message.content = 'tampered';
    await expect(
      verifyAgentContextProviderEnvelope({ envelope: providerTamper }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });

    const checkpointTamper = cloneEnvelope(result.envelope);
    checkpointTamper.plannerCheckpoint.budget.fixedInputTokens += 1;
    await expect(
      verifyAgentContextProviderEnvelope({ envelope: checkpointTamper }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });

    const canonicalTamper = result.bridge.sourceRows.map((row) => ({ ...row }));
    canonicalTamper.find((row) => row.kind === 'user')!.content = 'tampered';
    await expect(
      rebuildAgentContextProviderProjection({
        envelope: result.envelope,
        canonicalSourceRows: canonicalTamper,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });

  it('charges selected tool schemas and provider framing before planning', async () => {
    const tools: AgentModelToolDefinition[] = [
      {
        name: 'read_node',
        description: 'Read one canonical node.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      {
        name: 'rename_node',
        description: 'Rename one canonical node.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['id', 'title'],
        },
      },
    ];
    const fixedInputTokens = estimateAgentContextFixedInputTokens({
      tools,
      providerOverheadTokens: 111,
      perToolOverheadTokens: 7,
      estimateTokens: (text) => text.length,
    });
    const schemasOnly = estimateAgentContextFixedInputTokens({
      tools,
      providerOverheadTokens: 0,
      perToolOverheadTokens: 7,
      estimateTokens: (text) => text.length,
    });
    expect(fixedInputTokens).toBe(schemasOnly + 111);

    const result = await planAgentModelContext({
      systemPrompt: 'policy',
      messages: [{ role: 'user', content: 'hello' }],
      resolveToolAccess,
      planner: {
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.checkpoint.budget).toMatchObject({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      reservedOutputTokens: 4_096,
      safetyMarginTokens: 2_000,
      fixedInputTokens,
      usableInputBudgetTokens: 20_000 - 4_096 - 2_000 - fixedInputTokens,
    });

    const overBudget = await planAgentModelContext({
      systemPrompt: 'policy',
      messages: [
        { role: 'user', content: 'p'.repeat(1_000) },
      ],
      resolveToolAccess,
      planner: {
        contextWindowTokens: 10_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 4_650,
      },
    });
    expect(overBudget).toMatchObject({
      ok: false,
      error: { code: 'PINNED_CONTEXT_EXCEEDS_BUDGET' },
    });
  });

  it('round-trips canonical runtime denials for omitted and unknown tools as compressible pairs', async () => {
    const messages: AgentModelMessage[] = [
      { role: 'user', content: 'Try the available and missing tools.' },
      {
        role: 'assistant',
        content: [
          toolCall({
            callId: 'known-but-omitted',
            name: 'read_node',
            arguments: {},
          }),
          toolCall({
            callId: 'unknown-and-denied',
            name: 'missing_tool',
            arguments: {},
          }),
        ],
      },
      {
        role: 'tool',
        content: [
          deniedToolResult('known-but-omitted', 'read_node'),
          deniedToolResult('unknown-and-denied', 'missing_tool'),
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will recover without them.' }],
      },
    ];

    const result = await planAgentModelContext({
      systemPrompt: 'policy',
      messages,
      resolveToolAccess,
      planner: {
        contextWindowTokens: 10_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 100,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.bridge.sourceRows
        .filter(
          (row) =>
            row.kind === 'tool_call' || row.kind === 'tool_result',
        )
        .map((row) => row.toolAccess),
    ).toEqual(['denied', 'denied', 'denied', 'denied']);
    expect(
      result.plan.segments
        .filter(
          (segment) =>
            segment.type === 'source' &&
            (segment.row.kind === 'tool_call' ||
              segment.row.kind === 'tool_result'),
        )
        .map((segment) =>
          segment.type === 'source' ? segment.classification : null,
        ),
    ).toEqual([
      'compressible',
      'compressible',
      'compressible',
      'compressible',
    ]);
    expect(canonicalMessages(result.envelope.providerContext)).toEqual(
      messages,
    );
    await expect(
      rebuildAgentContextProviderProjection({
        envelope: result.envelope,
        canonicalSourceRows: result.bridge.sourceRows,
      }),
    ).resolves.toEqual(result.envelope.providerContext);
  });

  it.each([
    {
      label: 'missing provenance',
      result: {
        callId: 'unknown',
        name: 'not_policy_filtered',
        ok: false,
        content: agentRuntimeUnknownToolResultContent(
          'not_policy_filtered',
        ),
      },
    },
    {
      label: 'forged content',
      result: {
        ...deniedToolResult('unknown', 'not_policy_filtered'),
        content: 'forged denial',
      },
    },
    {
      label: 'mismatched canonical name',
      result: {
        ...deniedToolResult('unknown', 'not_policy_filtered'),
        content: agentRuntimeUnknownToolResultContent('another_tool'),
      },
    },
  ])('rejects an unknown tool denial with $label', ({ result }) => {
    expect(() =>
      agentModelMessagesToContextSources({
        systemPrompt: 'policy',
        messages: [
          { role: 'user', content: 'unknown tool' },
          {
            role: 'assistant',
            content: [
              toolCall({
                callId: 'unknown',
                name: 'not_policy_filtered',
                arguments: {},
              }),
            ],
          },
          {
            role: 'tool',
            content: [result as AgentToolResultBlock],
          },
        ],
        resolveToolAccess,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentContextMessageBridgeError>>({
        code: 'UNKNOWN_TOOL_ACCESS',
      }),
    );
  });

  it('rejects tools whose access was not resolved before context planning', () => {
    expect(() =>
      agentModelMessagesToContextSources({
        systemPrompt: 'policy',
        messages: [
          { role: 'user', content: 'unknown tool' },
          {
            role: 'assistant',
            content: [
              toolCall({
                callId: 'unknown',
                name: 'not_policy_filtered',
                arguments: {},
              }),
            ],
          },
          {
            role: 'tool',
            content: [
              {
                callId: 'unknown',
                name: 'not_policy_filtered',
                ok: true,
                content: 'should never happen',
              },
            ],
          },
        ],
        resolveToolAccess,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentContextMessageBridgeError>>({
        code: 'UNKNOWN_TOOL_ACCESS',
      }),
    );
  });
});
