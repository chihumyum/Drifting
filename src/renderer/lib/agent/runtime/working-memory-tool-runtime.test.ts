import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_WORKING_MEMORY_EDIT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
  AgentWorkingMemoryToolRuntime,
} from './working-memory-tool-runtime';
import type { AgentToolExecutionRequest } from './types';
import type { AgentWorkingMemorySnapshot } from '../../../domain/agent-working-memory';

const snapshot: AgentWorkingMemorySnapshot = {
  projectId: 'project-1',
  filename: 'WORKING_MEMORY.md',
  exists: true,
  contentMd: '# Working Memory\n\n## Current\n\n- 继续验收。\n',
  revision: 3,
  approxTokens: 18,
  updatedBy: 'agent',
  lastCompactedAt: null,
  updatedAt: '2026-08-12T15:00:00.000Z',
};

function request(name: string, args: Record<string, unknown>): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    idempotencyKey: 'effect-1',
    name,
    arguments: args,
    access: name === AGENT_WORKING_MEMORY_READ_TOOL ? 'read' : 'write',
    context: { route: { kind: 'chat', projectId: 'project-1' } },
    signal: new AbortController().signal,
  };
}

describe('Working Memory Agent tools', () => {
  it('publishes one refresh read and one optional update tool', () => {
    const runtime = new AgentWorkingMemoryToolRuntime();
    expect(runtime.listDefinitions().map((definition) => definition.name)).toEqual([
      AGENT_WORKING_MEMORY_READ_TOOL,
      AGENT_WORKING_MEMORY_EDIT_TOOL,
    ]);
  });

  it('returns the Markdown and exact revision to a refresh read', async () => {
    const runtime = new AgentWorkingMemoryToolRuntime({ load: vi.fn(async () => snapshot) });

    const result = await runtime.execute(request(AGENT_WORKING_MEMORY_READ_TOOL, {}));

    expect(result).toMatchObject({
      ok: true,
      data: { revision: 3, contentMd: snapshot.contentMd },
    });
    if (result.ok) expect(result.modelData).toContain('WORKING_MEMORY.md · revision 3');
  });

  it.each([
    { operation: 'update', expectedRevision: 3, contentMd: '# Working Memory\n' },
    { expectedRevision: 3, edits: [] },
    { expectedRevision: 3, edits: [{ oldText: '', newText: 'x' }] },
  ])('accepts only passage edits, never a whole rewrite: %j', (args) => {
    const definition = new AgentWorkingMemoryToolRuntime()
      .listDefinitions()
      .find((candidate) => candidate.name === AGENT_WORKING_MEMORY_EDIT_TOOL)!;
    expect(definition.validateInput(args)).toMatchObject({ ok: false });
  });

  it('applies passage edits to the current revision and saves with CAS', async () => {
    const save = vi.fn(async () => ({ snapshot: { ...snapshot, revision: 4 } }));
    const runtime = new AgentWorkingMemoryToolRuntime({ load: vi.fn(async () => snapshot), save });
    const args = {
      expectedRevision: 3,
      edits: [{ oldText: '- 继续验收。\n', newText: '- 继续验收。\n- 第三章待复核。\n' }],
    };
    const definition = runtime.listDefinitions()
      .find((candidate) => candidate.name === AGENT_WORKING_MEMORY_EDIT_TOOL)!;
    expect(definition.validateInput(args)).toEqual({ ok: true, value: args });

    const result = await runtime.execute(request(AGENT_WORKING_MEMORY_EDIT_TOOL, args));

    expect(result).toMatchObject({ ok: true, data: { snapshot: { revision: 4 } } });
    expect(save).toHaveBeenCalledWith('project-1', {
      contentMd: '# Working Memory\n\n## Current\n\n- 继续验收。\n- 第三章待复核。\n',
      expectedRevision: 3,
      updatedBy: 'agent',
    });
  });

  it('edits the starting outline when the document is empty', async () => {
    const empty = { ...snapshot, exists: false, contentMd: '', revision: 0 };
    const save = vi.fn(async () => ({ snapshot: { ...snapshot, revision: 1 } }));
    const runtime = new AgentWorkingMemoryToolRuntime({ load: vi.fn(async () => empty), save });
    const read = await runtime.execute(request(AGENT_WORKING_MEMORY_READ_TOOL, {}));
    if (read.ok) expect(read.modelData).toContain('## Current');
    await runtime.execute(
      request(AGENT_WORKING_MEMORY_EDIT_TOOL, {
        expectedRevision: 0,
        edits: [{ oldText: '## Current\n', newText: '## Current\n\n- 开始第四章\n' }],
      }),
    );
    expect(save).toHaveBeenCalledWith('project-1', expect.objectContaining({
      contentMd: expect.stringContaining('## Current\n\n- 开始第四章\n'),
    }));
  });

  it('reports a stale revision or missing passage without saving', async () => {
    const save = vi.fn();
    const runtime = new AgentWorkingMemoryToolRuntime({ load: vi.fn(async () => snapshot), save });
    const stale = await runtime.execute(
      request(AGENT_WORKING_MEMORY_EDIT_TOOL, {
        expectedRevision: 2,
        edits: [{ oldText: '- 继续验收。', newText: '' }],
      }),
    );
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining('WORKING_MEMORY_REVISION_CONFLICT') });
    const missing = await runtime.execute(
      request(AGENT_WORKING_MEMORY_EDIT_TOOL, {
        expectedRevision: 3,
        edits: [{ oldText: '- 不存在', newText: '' }],
      }),
    );
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('WORKING_MEMORY_EDIT_NOT_FOUND') });
    expect(save).not.toHaveBeenCalled();
  });
});
