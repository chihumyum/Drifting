import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
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
  it('publishes one refresh read and one mandatory checkpoint', () => {
    const runtime = new AgentWorkingMemoryToolRuntime();
    expect(runtime.listDefinitions().map((definition) => definition.name)).toEqual([
      AGENT_WORKING_MEMORY_READ_TOOL,
      AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
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

  it('records a semantic no-op without writing', async () => {
    const save = vi.fn();
    const runtime = new AgentWorkingMemoryToolRuntime({
      load: vi.fn(async () => snapshot),
      save,
    });

    const result = await runtime.execute(
      request(AGENT_WORKING_MEMORY_CHECKPOINT_TOOL, {
        operation: 'noop',
        expectedRevision: 3,
      }),
    );

    expect(result).toMatchObject({ ok: true, data: { operation: 'noop', revision: 3 } });
    expect(save).not.toHaveBeenCalled();
  });

  it('updates the singleton with revision CAS and Agent provenance', async () => {
    const save = vi.fn(async () => ({
      snapshot: { ...snapshot, revision: 4 },
      compacted: false,
      retiredEntries: 0,
    }));
    const runtime = new AgentWorkingMemoryToolRuntime({ save });

    const result = await runtime.execute(
      request(AGENT_WORKING_MEMORY_CHECKPOINT_TOOL, {
        operation: 'update',
        expectedRevision: 3,
        contentMd: snapshot.contentMd,
      }),
    );

    expect(result).toMatchObject({ ok: true, data: { snapshot: { revision: 4 } } });
    expect(save).toHaveBeenCalledWith('project-1', {
      contentMd: snapshot.contentMd,
      expectedRevision: 3,
      updatedBy: 'agent',
    });
  });
});
