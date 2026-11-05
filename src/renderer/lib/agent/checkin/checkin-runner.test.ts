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

  it('makes one forced single request and writes nothing, memory included', async () => {
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
            {
              title: '把「作者喜欢短句」挪进项目记忆',
              instruction: '工作记忆里的「长期：作者喜欢短句」是长期偏好：写进项目记忆，再从工作记忆删掉这一行；合并重复的「结局保持开放」。',
            },
          ],
          // Fields earlier check-ins used to edit memory directly.
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

    const message = seen[0]!.context.messages[0] as { message: { content: string } };
    expect(message.message.content).toContain('长期：作者喜欢短句');
    expect(message.message.content).toContain('结局保持开放。');

    expect(outcome.cards).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        title: '把人物卡的年龄改成与第三章一致',
        target: { entityType: 'node', entityId: 'chapter-3', title: '第三章' },
      }),
      expect.objectContaining({ title: '把「作者喜欢短句」挪进项目记忆', target: null }),
    ]);
    expect(outcome).not.toHaveProperty('memory');
    expect(memory.createMemory).not.toHaveBeenCalled();
    expect(memory.updateMemoryBody).not.toHaveBeenCalled();
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
    expect(working.saveAgentWorkingMemory).not.toHaveBeenCalled();
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

  it('completes when the model echoes the old maxItems keyword beside its cards', async () => {
    const outcome = await runProjectCheckin({
      projectId: 'project-1',
      projectName: '雾港档案',
      sinceIso: '2026-10-11T00:00:00.000Z',
      mode: 'resume',
      provider: 'openai-codex',
      model: 'gpt-6.1-terra',
      driver: fakeDriver(
        JSON.stringify({
          cards: [{ title: '从第三章接着写？', instruction: '回顾第三章并问作者从哪里继续。', target: 'c1' }],
          maxItems: 4,
        }),
        [],
      ),
    });
    expect(outcome.cards).toEqual([
      expect.objectContaining({ title: '从第三章接着写？', target: expect.objectContaining({ entityId: 'chapter-3' }) }),
    ]);
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
