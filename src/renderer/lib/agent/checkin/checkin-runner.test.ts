import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModelDriver, AgentModelRequest, AgentModelStreamEvent } from '../runtime/types';

const memory = vi.hoisted(() => ({
  createMemory: vi.fn(async () => ({ id: 'created' })),
  updateMemoryBody: vi.fn(async () => ({ id: 'mem-1' })),
  softDeleteMemory: vi.fn(async () => undefined),
  loadActiveMemories: vi.fn(async () => [
    { id: 'mem-1', body: '结局保持开放。', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'mem-2', body: '重复的条目。', createdAt: '2026-10-02T00:00:00.000Z' },
  ]),
}));
const working = vi.hoisted(() => ({
  loadAgentWorkingMemory: vi.fn(async () => ({ exists: true, contentMd: '# Working Memory\n\n## Recent\n- 长期：作者喜欢短句', revision: 7, approxTokens: 30 })),
  saveAgentWorkingMemory: vi.fn(async () => ({})),
}));
const delta = vi.hoisted(() => ({
  collectCheckinDelta: vi.fn(async () => [
    {
      ref: 'c1',
      entityType: 'node',
      entityId: 'chapter-3',
      objectKind: 'chapter',
      title: '第三章',
      lastChangedAt: '2026-10-11T12:00:00.000Z',
      revisions: { user: 2, agent: 0, remote: 0 },
      hasBaseline: true,
      digest: '+ 新段落',
    },
  ]),
}));

vi.mock('../../../usecase/useAgentMemory', () => memory);
vi.mock('../../../usecase/useAgentWorkingMemory', () => working);
vi.mock('./checkin-delta', () => delta);

import { runProjectCheckin } from './checkin-runner';
import { CHECKIN_TOOL_NAME } from './checkin-prompt';

function fakeDriver(argumentsJson: string, seen: AgentModelRequest[]): AgentModelDriver {
  return {
    id: 'fake-checkin',
    async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
      seen.push(request);
      yield { type: 'tool_call_start', callId: 'call-1', name: CHECKIN_TOOL_NAME } as AgentModelStreamEvent;
      yield { type: 'tool_args_delta', callId: 'call-1', delta: argumentsJson } as AgentModelStreamEvent;
      yield { type: 'finish', reason: 'tool_use' } as AgentModelStreamEvent;
    },
  } as AgentModelDriver;
}

describe('project check-in runner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('makes one forced single request and applies the memory upkeep it returns', async () => {
    const seen: AgentModelRequest[] = [];
    const outcome = await runProjectCheckin({
      projectId: 'project-1',
      projectName: '雾港档案',
      sinceIso: '2026-10-11T00:00:00.000Z',
      mode: 'changes',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      driver: fakeDriver(
        JSON.stringify({
          cards: [
            { title: '把人物卡的年龄改成与第三章一致', detail: '第三章改了她的年龄。', instruction: '把要素里的年龄改成与第三章一致。', target: 'c1' },
          ],
          workingMemoryEdits: [{ oldText: '\n- 长期：作者喜欢短句', newText: '' }],
          memoryAdd: ['作者喜欢短句。'],
          memoryUpdate: [{ memoryId: 'mem-1', body: '结局保持开放，留回声。' }],
          memoryDelete: ['mem-2'],
        }),
        seen,
      ),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      lifecycle: 'single_request',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      toolChoice: { force: CHECKIN_TOOL_NAME },
    });
    expect(seen[0]!.tools.map((tool) => tool.name)).toEqual([CHECKIN_TOOL_NAME]);
    expect(seen[0]!.context.messages).toHaveLength(1);

    expect(outcome.cards).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        title: '把人物卡的年龄改成与第三章一致',
        target: { entityType: 'node', entityId: 'chapter-3', title: '第三章' },
      }),
    ]);
    expect(memory.createMemory).toHaveBeenCalledWith('project-1', {
      kind: 'preference',
      body: '作者喜欢短句。',
      source: 'agent',
      status: 'active',
    });
    expect(memory.updateMemoryBody).toHaveBeenCalledWith('project-1', 'mem-1', '结局保持开放，留回声。');
    expect(memory.softDeleteMemory).toHaveBeenCalledWith('project-1', 'mem-2');
    expect(working.saveAgentWorkingMemory).toHaveBeenCalledWith('project-1', {
      contentMd: '# Working Memory\n\n## Recent',
      expectedRevision: 7,
      updatedBy: 'agent',
    });
    expect(outcome.memory).toEqual({ added: 1, updated: 1, deleted: 1, workingMemoryUpdated: true });
  });

  it('writes nothing when the model result is invalid', async () => {
    await expect(
      runProjectCheckin({
        projectId: 'project-1',
        projectName: '雾港档案',
        sinceIso: '2026-10-11T00:00:00.000Z',
        mode: 'changes',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        driver: fakeDriver('{"cards":"nope"}', []),
      }),
    ).rejects.toThrow('invalid');
    expect(memory.createMemory).not.toHaveBeenCalled();
    expect(working.saveAgentWorkingMemory).not.toHaveBeenCalled();
  });

  it('leaves a Working Memory too large for the check-in out of the request', async () => {
    working.loadAgentWorkingMemory.mockResolvedValueOnce({
      exists: true,
      contentMd: '# Working Memory\n\n- 很长',
      revision: 9,
      approxTokens: 25_000,
    });
    const seen: AgentModelRequest[] = [];
    await runProjectCheckin({
      projectId: 'project-1',
      projectName: '雾港档案',
      sinceIso: '2026-10-11T00:00:00.000Z',
      mode: 'changes',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      driver: fakeDriver(
        JSON.stringify({ cards: [], workingMemoryEdits: [{ oldText: '- 很长', newText: '' }] }),
        seen,
      ),
    });
    const message = seen[0]!.context.messages[0] as { message: { content: string } };
    expect(message.message.content).toContain('too large to include here');
    expect(working.saveAgentWorkingMemory).not.toHaveBeenCalled();
  });
});
